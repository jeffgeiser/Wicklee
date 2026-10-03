//! Postgres schema bootstrap and idempotent migrations.

// ── PG bootstrap ──────────────────────────────────────────────────────────────

pub(crate) async fn run_pg_migrations(pool: &sqlx::PgPool) {
    // ── Transactional tables ────────────────────────────────────────────────

    sqlx::query("
        CREATE TABLE IF NOT EXISTS users (
            id                     TEXT PRIMARY KEY,
            email                  TEXT UNIQUE NOT NULL,
            password_hash          TEXT NOT NULL,
            full_name              TEXT NOT NULL,
            role                   TEXT NOT NULL DEFAULT 'Owner',
            is_pro                 INTEGER NOT NULL DEFAULT 0,
            created_at             BIGINT NOT NULL,
            clerk_id               TEXT,
            subscription_tier      TEXT NOT NULL DEFAULT 'community',
            stripe_customer_id     TEXT,
            stripe_subscription_id TEXT,
            paddle_customer_id     TEXT,
            paddle_subscription_id TEXT
        )
    ").execute(pool).await.expect("users migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_users_clerk_id ON users(clerk_id)")
        .execute(pool).await.ok();

    // Paddle columns migration (for existing databases that only have stripe columns)
    sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS paddle_customer_id TEXT")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS paddle_subscription_id TEXT")
        .execute(pool).await.ok();
    // `occurred_at` of the last Paddle event applied to this user — webhooks
    // can arrive out of order, and an older event must not undo a newer one.
    sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS paddle_event_at TIMESTAMPTZ")
        .execute(pool).await.ok();
    // Set by DELETE /api/auth/stream-token; fleet SSE streams opened before it
    // end at their next refresh (stream tokens are only checked at connect).
    sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS streams_revoked_ms BIGINT")
        .execute(pool).await.ok();
    // Paddle webhooks resolve the user by subscription id, then customer id.
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_users_paddle_customer ON users(paddle_customer_id)")
        .execute(pool).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_users_paddle_subscription ON users(paddle_subscription_id)")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at BIGINT NOT NULL
        )
    ").execute(pool).await.expect("sessions migration failed");

    sqlx::query("
        CREATE TABLE IF NOT EXISTS nodes (
            wk_id               TEXT PRIMARY KEY,
            fleet_url            TEXT NOT NULL,
            session_token        TEXT NOT NULL,
            code                 TEXT,
            paired_at            BIGINT NOT NULL,
            last_seen            BIGINT NOT NULL,
            hostname             TEXT,
            user_id              TEXT,
            last_telemetry_json  JSONB,
            display_name         TEXT,
            tags                 TEXT
        )
    ").execute(pool).await.expect("nodes migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_nodes_user_id ON nodes(user_id)")
        .execute(pool).await.ok();
    // Migration for existing databases
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS display_name TEXT")
        .execute(pool).await.ok();
    // Fleet config management: cloud-side desired deployment profile.
    // NULL = agent keeps its local choice; set = delivered to the agent in
    // every telemetry response and applied within one push cycle (~2s).
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS desired_profile TEXT")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS tags TEXT")
        .execute(pool).await.ok();
    // Clerk Organizations: org_id on nodes enables shared fleet access.
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS org_id TEXT")
        .execute(pool).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_nodes_org ON nodes(org_id)")
        .execute(pool).await.ok();
    // Pairing-code lookups (claim collision check, activate). Partial: codes
    // are NULLed on redemption, so only pending claims are indexed. NOT
    // unique — codes are agent-chosen and stale duplicates may exist.
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_nodes_code ON nodes(code) WHERE code IS NOT NULL")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS stream_tokens (
            token      TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL,
            expires_ms BIGINT NOT NULL
        )
    ").execute(pool).await.expect("stream_tokens migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_stream_tokens_expires ON stream_tokens(expires_ms)")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE stream_tokens ADD COLUMN IF NOT EXISTS org_id TEXT")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS api_keys (
            key_id       TEXT PRIMARY KEY,
            key_hash     TEXT UNIQUE NOT NULL,
            user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            created_at   BIGINT NOT NULL,
            last_used_ms BIGINT
        )
    ").execute(pool).await.expect("api_keys migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)")
        .execute(pool).await.ok();
    // Org-wide API keys: NULL = personal key (original behavior). An org key
    // is minted by an org Admin and scopes the V1 API to the org's fleet.
    sqlx::query("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS org_id TEXT")
        .execute(pool).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_api_keys_org_id ON api_keys(org_id)")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS notification_channels (
            id           TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            channel_type TEXT NOT NULL CHECK (channel_type IN ('slack', 'email', 'pagerduty')),
            name         TEXT NOT NULL,
            config_json  JSONB NOT NULL,
            verified     INTEGER NOT NULL DEFAULT 0,
            created_at   BIGINT NOT NULL
        )
    ").execute(pool).await.expect("notification_channels migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_notif_channels_user ON notification_channels(user_id)")
        .execute(pool).await.ok();
    // Phase 7: add pagerduty to channel_type constraint (idempotent — Postgres allows re-adding same constraint).
    sqlx::query("ALTER TABLE notification_channels DROP CONSTRAINT IF EXISTS notification_channels_channel_type_check")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE notification_channels ADD CONSTRAINT notification_channels_channel_type_check CHECK (channel_type IN ('slack', 'email', 'pagerduty'))")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS alert_rules (
            id              TEXT PRIMARY KEY,
            user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            node_id         TEXT,
            event_type      TEXT NOT NULL,
            threshold_value REAL,
            urgency         TEXT NOT NULL DEFAULT 'immediate',
            channel_id      TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
            enabled         INTEGER NOT NULL DEFAULT 1,
            created_at      BIGINT NOT NULL
        )
    ").execute(pool).await.expect("alert_rules migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_alert_rules_user ON alert_rules(user_id)")
        .execute(pool).await.ok();
    // Tag scoping: a rule with a tag fires only for nodes bearing that tag
    // (comma-separated nodes.tags, matched case- and space-insensitively).
    sqlx::query("ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS tag TEXT")
        .execute(pool).await.ok();

    // Alert silences & maintenance windows. A silence suppresses matching
    // alert-rule notifications AND threshold-webhook fires while now is in
    // [starts_at, ends_at). starts_at in the future = a scheduled
    // maintenance window. Tenant-scoped: org members share silences.
    sqlx::query("
        CREATE TABLE IF NOT EXISTS alert_silences (
            id         TEXT PRIMARY KEY,
            tenant_id  TEXT NOT NULL,
            user_id    TEXT NOT NULL,
            node_id    TEXT,
            tag        TEXT,
            event_type TEXT,
            reason     TEXT NOT NULL DEFAULT '',
            starts_at  BIGINT NOT NULL,
            ends_at    BIGINT NOT NULL,
            created_at BIGINT NOT NULL
        )
    ").execute(pool).await.expect("alert_silences migration failed");
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_silences_tenant ON alert_silences(tenant_id, ends_at)")
        .execute(pool).await.ok();

    // ── SLOs with error budgets (Team+) ─────────────────────────────────────
    // An SLO declares "SLI within threshold for target_pct of 5-min windows
    // over a rolling 30 days." The evaluator writes one slo_windows row per
    // SLO per 5-min bucket (time-slice SLO — the standard shape), so monthly
    // compliance survives metrics_raw's 24h retention. last_burn_notified
    // tracks the highest burn threshold already alerted (0/50/90/100) so
    // budget alerts fire once per crossing, not every 5 minutes.
    sqlx::query("
        CREATE TABLE IF NOT EXISTS slo_definitions (
            id                  TEXT PRIMARY KEY,
            tenant_id           TEXT NOT NULL,
            user_id             TEXT NOT NULL,
            name                TEXT NOT NULL,
            tag                 TEXT,
            node_id             TEXT,
            metric              TEXT NOT NULL,
            threshold           DOUBLE PRECISION NOT NULL,
            target_pct          DOUBLE PRECISION NOT NULL,
            enabled             BOOLEAN NOT NULL DEFAULT true,
            last_burn_notified  SMALLINT NOT NULL DEFAULT 0,
            created_at          BIGINT NOT NULL
        )
    ").execute(pool).await.expect("slo_definitions migration failed");
    sqlx::query("
        CREATE TABLE IF NOT EXISTS slo_windows (
            slo_id    TEXT NOT NULL,
            ts        BIGINT NOT NULL,
            sli_value DOUBLE PRECISION,
            ok        BOOLEAN,
            PRIMARY KEY (slo_id, ts)
        )
    ").execute(pool).await.expect("slo_windows migration failed");
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_slo_windows_ts ON slo_windows(slo_id, ts DESC)")
        .execute(pool).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_alert_rules_channel ON alert_rules(channel_id)")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS alert_events (
            id                   TEXT PRIMARY KEY,
            rule_id              TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
            node_id              TEXT NOT NULL,
            triggered_at         BIGINT NOT NULL,
            resolved_at          BIGINT,
            quiet_until_ms       BIGINT,
            metrics_snapshot_json TEXT
        )
    ").execute(pool).await.expect("alert_events migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_alert_events_rule_node ON alert_events(rule_id, node_id)")
        .execute(pool).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_alert_events_open ON alert_events(resolved_at) WHERE resolved_at IS NULL")
        .execute(pool).await.ok();

    // ── Time-series tables ──────────────────────────────────────────────────

    sqlx::query("
        CREATE TABLE IF NOT EXISTS metrics_raw (
            ts               TIMESTAMPTZ NOT NULL,
            node_id          TEXT        NOT NULL,
            tenant_id        TEXT        NOT NULL,
            tok_s            REAL,
            watts            REAL,
            wes_raw          REAL,
            wes_penalized    REAL,
            thermal_cost_pct REAL,
            thermal_penalty  REAL,
            thermal_state    TEXT,
            vram_used_mb     INTEGER,
            vram_total_mb    INTEGER,
            mem_pressure_pct REAL,
            gpu_pct          REAL,
            cpu_pct          REAL,
            inference_state  TEXT,
            wes_version      SMALLINT    NOT NULL DEFAULT 1,
            agent_version    TEXT,
            swap_write       REAL,
            UNIQUE (tenant_id, node_id, ts)
        )
    ").execute(pool).await.expect("metrics_raw migration failed");

    // Additive column migration (idempotent — silently ignored if column exists)
    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS swap_write REAL")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS ttft_ms REAL")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS avg_latency_ms REAL")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS queue_depth INTEGER")
        .execute(pool).await.ok();
    // v0.9.0+ — per-row model attribution so fleet endpoints can aggregate by model.
    // Old rows stay NULL; queries filter `WHERE ollama_active_model IS NOT NULL`
    // so the model-comparison / model-switches / cost-by-model endpoints
    // degrade gracefully until new telemetry accumulates.
    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS ollama_active_model TEXT")
        .execute(pool).await.ok();

    // Convert to hypertable (idempotent check via exception handling)
    sqlx::query(
        "SELECT create_hypertable('metrics_raw', 'ts', if_not_exists => true)"
    ).execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS metrics_5min (
            ts                   TIMESTAMPTZ NOT NULL,
            node_id              TEXT        NOT NULL,
            tenant_id            TEXT        NOT NULL,
            tok_s_avg            REAL,
            tok_s_p50            REAL,
            tok_s_p95            REAL,
            watts_avg            REAL,
            wes_raw_avg          REAL,
            wes_penalized_avg    REAL,
            wes_penalized_min    REAL,
            thermal_cost_pct_avg REAL,
            thermal_cost_pct_max REAL,
            thermal_state_worst  TEXT,
            mem_pressure_pct_avg REAL,
            mem_pressure_pct_max REAL,
            gpu_pct_avg          REAL,
            inference_duty_pct   REAL,
            swap_write_avg       REAL,
            sample_count         SMALLINT    NOT NULL DEFAULT 0,
            wes_version          SMALLINT    NOT NULL DEFAULT 1,
            wes_version_count    SMALLINT    NOT NULL DEFAULT 1,
            agent_version        TEXT,
            UNIQUE (tenant_id, node_id, ts)
        )
    ").execute(pool).await.expect("metrics_5min migration failed");

    sqlx::query("ALTER TABLE metrics_5min ADD COLUMN IF NOT EXISTS swap_write_avg REAL")
        .execute(pool).await.ok();
    // v0.9.0+ — most-common active model in the 5-minute window.
    sqlx::query("ALTER TABLE metrics_5min ADD COLUMN IF NOT EXISTS ollama_active_model TEXT")
        .execute(pool).await.ok();

    // Time-integrated per-bucket totals (energy::*): each raw row weighted by
    // its real duration instead of a fixed 30 s. NULL on rows written before
    // these columns existed — readers fall back to watts_avg × bucket.
    for col in ["covered_s", "energy_wh", "live_energy_wh", "live_s", "tokens_est"] {
        sqlx::query(&format!("ALTER TABLE metrics_5min ADD COLUMN IF NOT EXISTS {col} REAL"))
            .execute(pool).await.ok();
    }

    sqlx::query(
        "SELECT create_hypertable('metrics_5min', 'ts', if_not_exists => true)"
    ).execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS node_events (
            ts          TIMESTAMPTZ NOT NULL,
            node_id     TEXT        NOT NULL,
            tenant_id   TEXT        NOT NULL,
            level       TEXT        NOT NULL DEFAULT 'info',
            event_type  TEXT,
            message     TEXT        NOT NULL,
            UNIQUE (tenant_id, node_id, ts, message)
        )
    ").execute(pool).await.expect("node_events migration failed");

    sqlx::query(
        "SELECT create_hypertable('node_events', 'ts', if_not_exists => true)"
    ).execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS fleet_observations (
            id              TEXT        NOT NULL,
            tenant_id       TEXT        NOT NULL,
            node_id         TEXT        NOT NULL,
            alert_type      TEXT        NOT NULL,
            severity        TEXT        NOT NULL DEFAULT 'warning',
            state           TEXT        NOT NULL DEFAULT 'open',
            title           TEXT        NOT NULL,
            detail          TEXT        NOT NULL,
            context_json    JSONB,
            fired_at_ms     BIGINT      NOT NULL,
            resolved_at_ms  BIGINT,
            ack_at_ms       BIGINT,
            PRIMARY KEY (id)
        )
    ").execute(pool).await.expect("fleet_observations migration failed");

    // Additive column migration — acknowledged_by tracks who acknowledged (Clerk user_id).
    sqlx::query("ALTER TABLE fleet_observations ADD COLUMN IF NOT EXISTS acknowledged_by TEXT")
        .execute(pool).await.ok();

    // Phase 7: source column distinguishes agent-pushed vs cloud-generated observations.
    sqlx::query("ALTER TABLE fleet_observations ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'cloud'")
        .execute(pool).await.ok();

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_observations_tenant_state ON fleet_observations(tenant_id, state, fired_at_ms)")
        .execute(pool).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_observations_node ON fleet_observations(tenant_id, node_id, fired_at_ms)")
        .execute(pool).await.ok();

    sqlx::query("
        CREATE TABLE IF NOT EXISTS schema_breakpoints (
            node_id         TEXT NOT NULL,
            ts_ms           BIGINT NOT NULL,
            tenant_id       TEXT NOT NULL,
            breakpoint_type TEXT NOT NULL,
            detail          TEXT
        )
    ").execute(pool).await.expect("schema_breakpoints migration failed");

    // ── Threshold Webhooks (Pro+ tier) ──────────────────────────────────────
    // User-registered webhook subscriptions for state-transition push
    // notifications. Replaces polling for users running NRO / agent
    // automation loops that need sub-second reaction to fleet state.
    //
    // Event types (v1):
    //   thermal_state_changed   — fires on any thermal_state transition
    //   inference_state_changed — fires on inference_state transition
    //   wes_below               — fires when WES crosses below threshold
    //   wes_above               — fires when WES crosses above threshold
    //
    // Cooldown is per-subscription, per-node — prevents flapping.
    sqlx::query("
        CREATE TABLE IF NOT EXISTS webhook_subscriptions (
            id            TEXT        PRIMARY KEY,
            user_id       TEXT        NOT NULL,
            tenant_id     TEXT        NOT NULL,
            url           TEXT        NOT NULL,
            secret        TEXT        NOT NULL,
            event_type    TEXT        NOT NULL,
            node_id       TEXT,
            threshold     REAL,
            cooldown_s    INTEGER     NOT NULL DEFAULT 60,
            enabled       BOOLEAN     NOT NULL DEFAULT true,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_fired_ms BIGINT
        )
    ").execute(pool).await.expect("webhook_subscriptions migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_webhook_subs_tenant ON webhook_subscriptions(tenant_id, enabled)")
        .execute(pool).await.ok();
    // Tag scoping — same semantics as alert_rules.tag.
    sqlx::query("ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS tag TEXT")
        .execute(pool).await.ok();

    // ── Model governance (Enterprise) ────────────────────────────────────────
    //
    // An allow-list of models per tenant, optionally scoped to a node tag.
    //
    // Governance is ACTIVE ONLY FOR SCOPES THAT HAVE AT LEAST ONE ROW. An empty
    // table means no governance and no violations — the fail-safe default, so
    // enabling the feature is an explicit act rather than something that starts
    // flagging every model in the fleet the moment the column exists.
    //
    //   tag IS NULL  — applies to the whole fleet
    //   tag = 'env:prod' — applies only to nodes carrying that tag
    //
    // A node's allowed set is the union of the fleet-wide entries and the
    // entries for every tag it carries.
    sqlx::query("
        CREATE TABLE IF NOT EXISTS model_policies (
            id         TEXT   PRIMARY KEY,
            tenant_id  TEXT   NOT NULL,
            model      TEXT   NOT NULL,
            tag        TEXT,
            note       TEXT,
            created_by TEXT   NOT NULL,
            created_at BIGINT NOT NULL
        )
    ").execute(pool).await.expect("model_policies migration failed");
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_model_policies_tenant ON model_policies(tenant_id)")
        .execute(pool).await.ok();
    // COALESCE on tag because Postgres treats NULLs as distinct in UNIQUE
    // indexes, which would otherwise allow unlimited duplicate fleet-wide rows.
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_model_policies_uniq \
         ON model_policies(tenant_id, lower(model), COALESCE(lower(tag), ''))"
    ).execute(pool).await.ok();

    // Per-node model tracking for edge detection.
    //
    // There was no live model-change detection anywhere in the cloud before
    // this: /api/v1/fleet/model-switches derives swaps retrospectively with a
    // LAG() window over metrics_raw, which is an analytics query, not a signal.
    // last_model is the model seen on the previous frame; last_flagged is the
    // model we have already raised a violation for, so a node sitting on an
    // unapproved model doesn't re-flag on every 1 Hz telemetry push. Returning
    // to an approved model clears last_flagged, so a repeat offence re-flags.
    sqlx::query("
        CREATE TABLE IF NOT EXISTS model_policy_state (
            tenant_id       TEXT   NOT NULL,
            node_id         TEXT   NOT NULL,
            last_model      TEXT,
            last_flagged    TEXT,
            last_flagged_ms BIGINT,
            PRIMARY KEY (tenant_id, node_id)
        )
    ").execute(pool).await.expect("model_policy_state migration failed");

    // Violation log. Deliberately NOT audit_log: that table is actor-keyed
    // (user_id NOT NULL, actor_email) and a violation is detected by the
    // telemetry path with no acting user. Recording one there would mean
    // inventing an actor. Policy *changes* are audited, because those do have
    // one. See docs/MODEL_GOVERNANCE.md.
    sqlx::query("
        CREATE TABLE IF NOT EXISTS model_policy_violations (
            id        BIGSERIAL PRIMARY KEY,
            tenant_id TEXT   NOT NULL,
            node_id   TEXT   NOT NULL,
            model     TEXT   NOT NULL,
            scope     TEXT,
            ts_ms     BIGINT NOT NULL
        )
    ").execute(pool).await.expect("model_policy_violations migration failed");
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_model_policy_viol_tenant ON model_policy_violations(tenant_id, ts_ms DESC)")
        .execute(pool).await.ok();

    // Per-(subscription, node) state used to detect transitions and crossings.
    // For thermal/inference: prev_value stores last seen string state.
    // For wes_below/above: prev_value_num stores last seen WES numeric.
    sqlx::query("
        CREATE TABLE IF NOT EXISTS webhook_state (
            subscription_id TEXT   NOT NULL,
            node_id         TEXT   NOT NULL,
            prev_value      TEXT,
            prev_value_num  REAL,
            last_fired_ms   BIGINT,
            PRIMARY KEY (subscription_id, node_id)
        )
    ").execute(pool).await.expect("webhook_state migration failed");

    // ── OpenTelemetry export configuration (Team+ tier) ─────────────────────
    sqlx::query("
        CREATE TABLE IF NOT EXISTS otel_config (
            user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            enabled          BOOLEAN NOT NULL DEFAULT false,
            endpoint_url     TEXT NOT NULL DEFAULT '',
            auth_headers     TEXT NOT NULL DEFAULT '{}',
            export_interval_s INTEGER NOT NULL DEFAULT 30,
            created_at       BIGINT NOT NULL DEFAULT 0,
            updated_at       BIGINT NOT NULL DEFAULT 0
        )
    ").execute(pool).await.expect("otel_config migration failed");

    // ── Organizations (Clerk Organizations, Team+ tier) ────────────────────
    sqlx::query("
        CREATE TABLE IF NOT EXISTS organizations (
            org_id              TEXT PRIMARY KEY,
            name                TEXT,
            subscription_tier   TEXT NOT NULL DEFAULT 'community',
            created_by          TEXT,
            created_at          BIGINT NOT NULL DEFAULT 0
        )
    ").execute(pool).await.expect("organizations migration failed");

    // Paddle tier sync updates every org a paying user created.
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_organizations_created_by ON organizations(created_by)")
        .execute(pool).await.ok();

    // ── Audit log (Business+ tier) ──────────────────────────────────────────
    // Append-only: no UPDATE/DELETE paths exist anywhere in the codebase.
    sqlx::query("
        CREATE TABLE IF NOT EXISTS audit_log (
            id          BIGSERIAL PRIMARY KEY,
            ts          BIGINT NOT NULL,
            user_id     TEXT NOT NULL,
            org_id      TEXT,
            actor_email TEXT NOT NULL DEFAULT '',
            action      TEXT NOT NULL,
            target      TEXT NOT NULL DEFAULT '',
            details     JSONB
        )
    ").execute(pool).await.expect("audit_log migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, ts DESC)")
        .execute(pool).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_audit_log_org ON audit_log(org_id, ts DESC)")
        .execute(pool).await.ok();

    // SIEM drain — one per tenant. Streams new audit events to a customer
    // HTTPS endpoint, HMAC-signed like threshold webhooks. `last_id` is the
    // delivery cursor (starts at the tenant's max id at creation — history
    // backfill is the export endpoint's job, not the drain's).
    sqlx::query("
        CREATE TABLE IF NOT EXISTS audit_drains (
            tenant_id        TEXT PRIMARY KEY,
            user_id          TEXT NOT NULL,
            org_id           TEXT,
            url              TEXT NOT NULL,
            secret           TEXT NOT NULL,
            enabled          BOOLEAN NOT NULL DEFAULT true,
            last_id          BIGINT NOT NULL DEFAULT 0,
            failures         INT NOT NULL DEFAULT 0,
            last_delivery_ms BIGINT,
            created_at       BIGINT NOT NULL
        )
    ").execute(pool).await.expect("audit_drains migration failed");

    // ── Weekly idle-waste digest opt-in (Team+ tier) ────────────────────────
    // One per tenant, like audit_drains: owner user_id + org_id kept for tier
    // re-resolution at send time.
    sqlx::query("
        CREATE TABLE IF NOT EXISTS digest_settings (
            tenant_id    TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL,
            org_id       TEXT,
            email        TEXT NOT NULL,
            enabled      BOOLEAN NOT NULL DEFAULT true,
            last_sent_ms BIGINT NOT NULL DEFAULT 0,
            created_at   BIGINT NOT NULL
        )
    ").execute(pool).await.expect("digest_settings migration failed");

    // Install telemetry — anonymous counter, no PII.
    sqlx::query("
        CREATE TABLE IF NOT EXISTS installs (
            id      BIGSERIAL PRIMARY KEY,
            ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            os      TEXT NOT NULL,
            arch    TEXT NOT NULL,
            version TEXT NOT NULL DEFAULT 'unknown',
            nvidia  BOOLEAN NOT NULL DEFAULT FALSE,
            upgrade BOOLEAN NOT NULL DEFAULT FALSE
        )
    ").execute(pool).await.expect("installs migration failed");

    // Model catalog — cached HuggingFace GGUF metadata for model discovery.
    // Guard: if the table exists with a stale schema (missing model_id column),
    // drop it so the CREATE TABLE below recreates it correctly.  The catalog is
    // always re-fetched at startup so dropping it loses nothing permanent.
    sqlx::query("
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'model_catalog'
            ) AND NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name   = 'model_catalog'
                  AND column_name  = 'model_id'
            ) THEN
                DROP TABLE model_catalog;
            END IF;
        END $$;
    ").execute(pool).await.expect("model_catalog schema guard failed");

    sqlx::query("
        CREATE TABLE IF NOT EXISTS model_catalog (
            model_id    TEXT    NOT NULL,
            filename    TEXT    NOT NULL,
            quant_level TEXT    NOT NULL,
            file_size   BIGINT  NOT NULL,
            downloads   BIGINT  NOT NULL DEFAULT 0,
            fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (model_id, filename)
        )
    ").execute(pool).await.expect("model_catalog migration failed");

    // Additive: HuggingFace likes — current taste signal (vs downloads which
    // skew toward older, well-established models). Populated by the same
    // refresh task. Default 0 for any rows written before this migration.
    sqlx::query("ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS likes BIGINT NOT NULL DEFAULT 0")
        .execute(pool).await.ok();

    // (Removed: a boot-time backfill that gave every unowned node to the sole
    // user whenever exactly one user existed. It ran on EVERY boot, so on a
    // single-user install any pending or spam `/api/pair/claim` row became an
    // owned node without the 6-digit activation step.)

    println!("  PG migrations complete");
}
