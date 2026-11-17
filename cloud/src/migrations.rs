//! Postgres schema bootstrap and idempotent migrations.

pub(crate) async fn run_pg_migrations(pool: &sqlx::PgPool) {

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

    sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS paddle_customer_id TEXT")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS paddle_subscription_id TEXT")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS paddle_event_at TIMESTAMPTZ")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE users ADD COLUMN IF NOT EXISTS streams_revoked_ms BIGINT")
        .execute(pool).await.ok();
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
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS display_name TEXT")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS desired_profile TEXT")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS tags TEXT")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE nodes ADD COLUMN IF NOT EXISTS org_id TEXT")
        .execute(pool).await.ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_nodes_org ON nodes(org_id)")
        .execute(pool).await.ok();
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
    sqlx::query("ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS tag TEXT")
        .execute(pool).await.ok();

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

    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS swap_write REAL")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS ttft_ms REAL")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS avg_latency_ms REAL")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS queue_depth INTEGER")
        .execute(pool).await.ok();
    sqlx::query("ALTER TABLE metrics_raw ADD COLUMN IF NOT EXISTS ollama_active_model TEXT")
        .execute(pool).await.ok();

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
    sqlx::query("ALTER TABLE metrics_5min ADD COLUMN IF NOT EXISTS ollama_active_model TEXT")
        .execute(pool).await.ok();

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

    sqlx::query("ALTER TABLE fleet_observations ADD COLUMN IF NOT EXISTS acknowledged_by TEXT")
        .execute(pool).await.ok();

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
    sqlx::query("ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS tag TEXT")
        .execute(pool).await.ok();

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
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_model_policies_uniq \
         ON model_policies(tenant_id, lower(model), COALESCE(lower(tag), ''))"
    ).execute(pool).await.ok();

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

    sqlx::query("
        CREATE TABLE IF NOT EXISTS organizations (
            org_id              TEXT PRIMARY KEY,
            name                TEXT,
            subscription_tier   TEXT NOT NULL DEFAULT 'community',
            created_by          TEXT,
            created_at          BIGINT NOT NULL DEFAULT 0
        )
    ").execute(pool).await.expect("organizations migration failed");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_organizations_created_by ON organizations(created_by)")
        .execute(pool).await.ok();

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

    sqlx::query("ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS likes BIGINT NOT NULL DEFAULT 0")
        .execute(pool).await.ok();

    println!("  PG migrations complete");
}
