//! Authentication and tenancy: Clerk JWT/JWKS, legacy sessions, RBAC (OrgRole), tenant scoping, tier resolution, and the auth HTTP handlers.

use crate::*;

// ── Clerk JWT helpers ─────────────────────────────────────────────────────────

/// Fetch JWKS from Clerk. Synchronous — call from spawn_blocking.
pub(crate) fn fetch_jwks(url: &str) -> Vec<JwkKey> {
    match HTTP_AGENT.get(url).call() {
        Ok(resp) => resp.into_json::<JwksResponse>()
            .map(|j| j.keys)
            .unwrap_or_default(),
        Err(e) => {
            eprintln!("[jwks] fetch failed: {e}");
            vec![]
        }
    }
}

/// Verify a Clerk JWT and return the `sub` claim (Clerk user ID), optional
/// `org_id`, and optional org role string (e.g. "org:admin"). Handles both
/// Clerk token shapes: v1 top-level `org_id`/`org_role`, and v2 nested
/// `o: { id, rol }` (rol carries no "org:" prefix).
pub(crate) fn validate_clerk_jwt(token: &str, keys: &[JwkKey]) -> Option<(String, Option<String>, Option<String>)> {
    #[derive(Deserialize)]
    struct ClerkOrgClaim {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        rol: Option<String>,
    }
    #[derive(Deserialize)]
    struct ClerkClaims {
        sub: String,
        #[serde(default)]
        org_id: Option<String>,
        #[serde(default)]
        org_role: Option<String>,
        #[serde(default)]
        o: Option<ClerkOrgClaim>,
    }

    if keys.is_empty() {
        eprintln!("[auth] clerk_keys is empty — CLERK_JWKS_URL not set or fetch failed");
        return None;
    }

    let header = match jsonwebtoken::decode_header(token) {
        Ok(h) => h,
        Err(e) => { eprintln!("[auth] JWT decode_header failed: {e}"); return None; }
    };

    let candidates: Vec<&JwkKey> = match &header.kid {
        Some(kid) => {
            let m: Vec<&JwkKey> = keys.iter().filter(|k| &k.kid == kid).collect();
            if m.is_empty() {
                eprintln!("[auth] JWT kid={kid} not found in JWKS ({} keys cached)", keys.len());
                keys.iter().collect()
            } else { m }
        }
        None => {
            eprintln!("[auth] JWT has no kid — trying all {} cached keys", keys.len());
            keys.iter().collect()
        }
    };

    let mut val = Validation::new(Algorithm::RS256);
    val.validate_aud = false;
    val.leeway = 60;

    for jwk in &candidates {
        match DecodingKey::from_rsa_components(&jwk.n, &jwk.e) {
            Err(e) => { eprintln!("[auth] DecodingKey build failed for kid={}: {e}", jwk.kid); }
            Ok(key) => match decode::<ClerkClaims>(token, &key, &val) {
                Ok(data) => {
                    let c = data.claims;
                    let (o_id, o_rol) = c.o.map(|o| (o.id, o.rol)).unwrap_or((None, None));
                    let org_id   = c.org_id.or(o_id);
                    let org_role = c.org_role.or(o_rol);
                    return Some((c.sub, org_id, org_role));
                }
                Err(e) => { eprintln!("[auth] JWT decode failed for kid={}: {e}", jwk.kid); }
            }
        }
    }
    eprintln!("[auth] JWT validation exhausted all candidates");
    None
}

/// Map a Clerk `sub` to an internal user ID, creating or linking the record as needed.
pub(crate) async fn resolve_clerk_user(clerk_sub: &str, pool: &sqlx::PgPool) -> Option<String> {
    // Already linked?
    if let Ok(row) = sqlx::query_scalar::<_, String>(
        "SELECT id FROM users WHERE clerk_id = $1"
    ).bind(clerk_sub).fetch_one(pool).await {
        return Some(row);
    }

    // No "link the sole unmapped user" fallback. That DIY→Clerk migration
    // shortcut attached the next NEW Clerk identity to whichever account had
    // `clerk_id IS NULL` — and the public legacy signup route created exactly
    // such accounts, so anyone could register a password account and capture
    // the next stranger's Clerk sign-in (nodes, keys, billing). Migrating a
    // legacy account now means setting `users.clerk_id` by hand.

    // New Clerk user — create a minimal record.
    let new_id = Uuid::new_v4().to_string();
    let ts     = now_ms() as i64;
    let r = sqlx::query(
        "INSERT INTO users (id, email, password_hash, full_name, role, is_pro, created_at, clerk_id)
         VALUES ($1, $2, '', 'Clerk User', 'Owner', 0, $3, $2)"
    ).bind(&new_id).bind(clerk_sub).bind(ts)
    .execute(pool).await;
    if r.is_ok() { Some(new_id) } else { None }
}

// ── Auth helpers (async) ──────────────────────────────────────────────────────

/// Validate a Bearer token and return the internal user_id.
/// Tries the legacy sessions table first, then Clerk JWT.
pub(crate) async fn require_user(token: &str, pool: &sqlx::PgPool, clerk_keys: &[JwkKey]) -> Option<String> {
    require_user_and_org(token, pool, clerk_keys).await.map(|(uid, _)| uid)
}

/// Authenticate and return `(user_id, verified_org_id)`.
///
/// The org_id comes from the Clerk JWT's `org_id` claim — Clerk only embeds it
/// when the user has the org active in their session, so it is membership-
/// verified by Clerk. This MUST be the only source of org identity for
/// tenancy: an earlier version read org_id from the client-supplied X-Org-Id
/// header, which let any authenticated user scope queries to ANY org by
/// guessing its (non-secret) Clerk org id — a cross-tenant read of fleet,
/// telemetry, observations, and MCP output. Legacy DIY sessions predate orgs
/// and always resolve to a None org.
pub(crate) async fn require_user_and_org(
    token: &str,
    pool: &sqlx::PgPool,
    clerk_keys: &[JwkKey],
) -> Option<(String, Option<String>)> {
    require_user_org_role(token, pool, clerk_keys).await
        .map(|(uid, org, _role)| (uid, org))
}

/// RBAC role within the active organization, derived from the verified Clerk
/// JWT's org role claim — never from the client. Solo users (no org in the
/// session) are Admin over their own resources; tenancy scoping already
/// confines them to those. Clerk built-in roles: "org:admin" / "org:member";
/// a custom "org:viewer" role (configurable in Clerk) maps to read-only.
/// Unknown custom roles default to Member so a bespoke ops role isn't
/// accidentally locked out of day-to-day work — Admin is never inferred.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum OrgRole { Admin, Member, Viewer }

impl OrgRole {
    pub(crate) fn from_claim(role: Option<&str>, has_org: bool) -> Self {
        if !has_org { return OrgRole::Admin; }
        match role.map(|r| r.strip_prefix("org:").unwrap_or(r)) {
            Some("admin")  => OrgRole::Admin,
            Some("viewer") => OrgRole::Viewer,
            // "member", "basic_member", custom roles, or a missing claim on
            // an org session → Member (least-privilege for Admin, but not
            // read-only — Clerk always sends the role for org sessions).
            _ => OrgRole::Member,
        }
    }

    /// Viewers cannot mutate anything.
    pub(crate) fn can_mutate(&self) -> bool { !matches!(self, OrgRole::Viewer) }
    pub(crate) fn is_admin(&self)   -> bool { matches!(self, OrgRole::Admin) }
}

/// 403 body for role-policy denials — names the required role so the
/// frontend can render a useful message instead of a generic failure.
pub(crate) fn role_forbidden(required: &str) -> axum::response::Response {
    (StatusCode::FORBIDDEN, Json(serde_json::json!({
        "error": format!("Your organization role does not permit this action ({required} required)"),
        "role_required": required,
    }))).into_response()
}

/// Validate a scoping tag for alert rules / webhook subscriptions.
/// Comma-free (node tags are stored comma-separated) and restricted to a
/// safe charset so the SQL LIKE match can't be gamed with % wildcards.
pub(crate) fn valid_scope_tag(tag: &str) -> bool {
    !tag.is_empty() && tag.len() <= 64
        && tag.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_' | '.'))
}

/// Like `require_user_and_org` but also returns the caller's [`OrgRole`].
/// Mutating handlers use this; read-only handlers keep the 2-tuple wrapper.
pub(crate) async fn require_user_org_role(
    token: &str,
    pool: &sqlx::PgPool,
    clerk_keys: &[JwkKey],
) -> Option<(String, Option<String>, OrgRole)> {
    // Legacy DIY sessions — no org concept, full control of own resources.
    // Only honored where password auth is enabled (no Clerk), and only for
    // LEGACY_SESSION_TTL_MS after login; they used to be valid forever.
    if legacy_auth_enabled()
        && let Ok(id) = sqlx::query_scalar::<_, String>(
            "SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token = $1 AND s.created_at >= $2"
        ).bind(token).bind(legacy_session_cutoff()).fetch_one(pool).await
    {
        return Some((id, None, OrgRole::Admin));
    }

    // Clerk JWT — trust the signed org_id + role claims, never a header.
    let (sub, org_id, org_role) = validate_clerk_jwt(token, clerk_keys)?;
    let user_id = resolve_clerk_user(&sub, pool).await?;
    let role = OrgRole::from_claim(org_role.as_deref(), org_id.is_some());
    Some((user_id, org_id, role))
}

/// Returns (column_predicate, bind_value) for tenant-scoped queries, used as
/// `WHERE {col} = $n`. With an org, scope to org_id. Otherwise scope to the
/// user's PERSONAL rows only: `org_id IS NULL AND user_id`. A bare `user_id`
/// also matched rows the user created inside an org, so after being removed
/// from the org they could still see and control those nodes (and read the
/// org's audit entries) from a personal session. This matches the
/// `COALESCE(org_id, user_id)` tenant key used elsewhere.
pub(crate) fn tenant_scope<'a>(user_id: &'a str, org_id: &'a Option<String>) -> (&'static str, &'a str) {
    match org_id.as_deref() {
        Some(oid) => ("org_id", oid),
        None => ("org_id IS NULL AND user_id", user_id),
    }
}

/// True when `node_id` is visible to the authenticated tenant.
///
/// Org members share the org's nodes; solo users see only their own. Scopes
/// by the same column `tenant_scope` picks, so a node paired under an org
/// (org_id set) is reachable by any member, and a personal node (org_id NULL)
/// only by its owner. The column is a hardcoded literal — never caller data —
/// so the format!() carries no injection surface.
pub(crate) async fn node_in_tenant(
    node_id: &str,
    user_id: &str,
    org_id: &Option<String>,
    pool: &sqlx::PgPool,
) -> bool {
    let (tcol, tval) = tenant_scope(user_id, org_id);
    sqlx::query_scalar::<_, i64>(
        &format!("SELECT COUNT(*) FROM nodes WHERE wk_id = $1 AND {tcol} = $2")
    ).bind(node_id).bind(tval).fetch_one(pool).await.unwrap_or(0) > 0
}

/// The tenant_id a NODE's telemetry/observations/events are stored under:
/// org_id when org-paired, else the owning user's id. This is THE rule for
/// every tenant_id read or write in ingest/background paths (it's what
/// handle_telemetry stamps onto metrics rows). JWT-side reads use
/// tenant_scope(), which yields the same value for any node that
/// node_in_tenant() admits. None = node unknown or not yet paired.
pub(crate) async fn node_tenant_id(node_id: &str, pool: &sqlx::PgPool) -> Option<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT COALESCE(org_id, user_id) FROM nodes WHERE wk_id = $1 AND user_id IS NOT NULL"
    ).bind(node_id).fetch_one(pool).await.ok()
}

/// Tier governing a NODE's entitlements — the org's subscription when
/// org-paired, else the owning user's. Background-path counterpart of
/// resolve_tier() (which resolves from JWT identity). Previously these
/// paths looked up `users.subscription_tier` keyed by tenant_id, which is
/// an org id for org-paired nodes — resolving to 'community' and silently
/// disabling alerts/webhooks for every org fleet.
pub(crate) async fn resolve_node_tier(node_id: &str, pool: &sqlx::PgPool) -> String {
    if is_self_hosted() { return "enterprise".to_string(); }
    sqlx::query_scalar::<_, String>(
        "SELECT COALESCE(
             (SELECT o.subscription_tier FROM organizations o WHERE o.org_id = n.org_id),
             u.subscription_tier,
             'community')
         FROM nodes n LEFT JOIN users u ON u.id = n.user_id
         WHERE n.wk_id = $1"
    ).bind(node_id).fetch_one(pool).await
    .unwrap_or_else(|_| "community".to_string())
}

/// Self-hosted control plane mode (`SELF_HOSTED=true`). An Enterprise
/// deployment running the cloud on its own infrastructure has no Paddle in
/// the box — every tenant resolves to the enterprise tier, because feature
/// entitlement came with the license, not a subscription row. The license
/// key itself is soft-enforced: logged at boot and surfaced in /health, so
/// evaluations aren't bricked but production use is honest about licensing.
pub(crate) fn is_self_hosted() -> bool {
    static FLAG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *FLAG.get_or_init(|| {
        matches!(std::env::var("SELF_HOSTED").as_deref(), Ok("true") | Ok("1"))
    })
}

/// Legacy email/password auth (`/api/auth/signup`, `/api/auth/login`) is the
/// DIY path for self-hosted installs without a Clerk app. When Clerk is
/// configured it is disabled: the frontend never uses it, and password
/// accounts beside Clerk identities are pure attack surface (unverified
/// emails, e.g. registering `DEV_ACCOUNT_EMAIL`).
pub(crate) fn legacy_auth_enabled() -> bool {
    static FLAG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *FLAG.get_or_init(|| {
        std::env::var("CLERK_JWKS_URL").map(|v| v.trim().is_empty()).unwrap_or(true)
    })
}

/// Legacy password sessions expire this long after login.
pub(crate) const LEGACY_SESSION_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;

pub(crate) fn legacy_session_cutoff() -> i64 {
    now_ms().saturating_sub(LEGACY_SESSION_TTL_MS) as i64
}

pub(crate) fn legacy_auth_disabled() -> axum::response::Response {
    (StatusCode::NOT_FOUND, Json(serde_json::json!({
        "error": "Password sign-in is disabled on this deployment. Sign in with Clerk."
    }))).into_response()
}

/// Resolve subscription tier — checks organizations table for org users,
/// falls back to users table for solo users. Self-hosted deployments are
/// always enterprise (see is_self_hosted).
pub(crate) async fn resolve_tier(user_id: &str, org_id: &Option<String>, pool: &sqlx::PgPool) -> String {
    if is_self_hosted() { return "enterprise".to_string(); }
    if let Some(oid) = org_id {
        // Org-level tier takes precedence
        if let Ok(tier) = sqlx::query_scalar::<_, String>(
            "SELECT subscription_tier FROM organizations WHERE org_id = $1"
        ).bind(oid).fetch_one(pool).await {
            return tier;
        }
    }
    // Fall back to user-level tier
    sqlx::query_scalar::<_, String>(
        "SELECT subscription_tier FROM users WHERE id = $1"
    ).bind(user_id).fetch_one(pool).await
    .unwrap_or_else(|_| "community".to_string())
}

/// Like require_user but also returns email, is_pro, the verified org_id,
/// and the caller's [`OrgRole`].
pub(crate) async fn require_user_info(
    token: &str,
    pool: &sqlx::PgPool,
    clerk_keys: &[JwkKey],
) -> Option<(String, String, i32, Option<String>, OrgRole)> {
    let (user_id, org_id, role) = require_user_org_role(token, pool, clerk_keys).await?;
    let row = sqlx::query_as::<_, (String, i32)>(
        "SELECT email, is_pro FROM users WHERE id = $1"
    ).bind(&user_id).fetch_one(pool).await.ok()?;
    Some((user_id, row.0, row.1, org_id, role))
}

// ── Auth handlers ─────────────────────────────────────────────────────────────

/// GET /api/auth/stream-token
pub(crate) async fn handle_stream_token(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let (user_id, org_id) = match require_user_and_org(&token, &state.pool, &clerk_keys).await {
        Some(v) => v,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
    };

    let stream_token = Uuid::new_v4().to_string();
    let expires_ms = (now_ms() + 60_000) as i64;

    let _ = sqlx::query(
        "INSERT INTO stream_tokens (token, user_id, expires_ms, org_id) VALUES ($1, $2, $3, $4)"
    ).bind(&stream_token).bind(&user_id).bind(expires_ms).bind(&org_id)
    .execute(&state.pool).await;

    (StatusCode::OK, Json(serde_json::json!({ "stream_token": stream_token }))).into_response()
}

/// DELETE /api/auth/stream-token — revoke all stream tokens for the current user (called on logout).
pub(crate) async fn handle_revoke_stream_tokens(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return StatusCode::UNAUTHORIZED,
    };

    let clerk_keys = state.clerk_keys.read().unwrap().clone();
    let user_id = match require_user(&token, &state.pool, &clerk_keys).await {
        Some(uid) => uid,
        None => return StatusCode::UNAUTHORIZED,
    };

    let _ = sqlx::query("DELETE FROM stream_tokens WHERE user_id = $1")
        .bind(&user_id).execute(&state.pool).await;
    let _ = sqlx::query("UPDATE users SET streams_revoked_ms = $1 WHERE id = $2")
        .bind(now_ms() as i64).bind(&user_id).execute(&state.pool).await;

    audit(&state.pool, &user_id, &None, "stream_tokens.revoked", "", serde_json::json!({}));
    StatusCode::NO_CONTENT
}

/// POST /api/auth/signup
pub(crate) async fn handle_signup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SignupRequest>,
) -> impl IntoResponse {
    if !legacy_auth_enabled() { return legacy_auth_disabled(); }
    let ip = client_ip(&headers);
    if !check_auth_rate_limit(&ip, &state.auth_rate_limits) {
        return (StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "Too many requests. Try again in a minute." }))).into_response();
    }
    let email = body.email.trim().to_lowercase();

    if email.is_empty() || !email.contains('@') {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Valid email required" }))).into_response();
    }
    if body.password.len() < 8 {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Password must be at least 8 characters" }))).into_response();
    }
    if body.full_name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Full name required" }))).into_response();
    }
    // Signup emails are never verified, so the DEV_ACCOUNT_EMAIL address
    // (which bypasses node limits) can't be claimed through this route.
    if is_dev_account(&email) {
        return (StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "This address can't be registered here" }))).into_response();
    }

    let password = body.password.clone();
    let password_hash = match tokio::task::spawn_blocking(move || bcrypt::hash(password, 12))
        .await.unwrap()
    {
        Ok(h) => h,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response(),
    };

    // Check for duplicate email.
    let exists: bool = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)"
    ).bind(&email).fetch_one(&state.pool).await.unwrap_or(false);
    if exists {
        return (StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "An account with this email already exists" }))).into_response();
    }

    let id        = Uuid::new_v4().to_string();
    let token     = Uuid::new_v4().to_string();
    let full_name = body.full_name.trim().to_owned();
    let ts        = now_ms() as i64;

    let r = sqlx::query(
        "INSERT INTO users (id, email, password_hash, full_name, role, is_pro, created_at)
         VALUES ($1, $2, $3, $4, 'Owner', 0, $5)"
    ).bind(&id).bind(&email).bind(&password_hash).bind(&full_name).bind(ts)
    .execute(&state.pool).await;

    if r.is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Internal error" }))).into_response();
    }

    let _ = sqlx::query(
        "INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)"
    ).bind(&token).bind(&id).bind(ts)
    .execute(&state.pool).await;

    let is_pro = is_dev_account(&email);
    (StatusCode::CREATED, Json(AuthResponse {
        token,
        user: UserResponse { id, email, full_name, role: "Owner".into(), is_pro },
    })).into_response()
}

/// POST /api/auth/login
pub(crate) async fn handle_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LoginRequest>,
) -> impl IntoResponse {
    if !legacy_auth_enabled() { return legacy_auth_disabled(); }
    let ip = client_ip(&headers);
    if !check_auth_rate_limit(&ip, &state.auth_rate_limits) {
        return (StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "Too many requests. Try again in a minute." }))).into_response();
    }
    let email = body.email.trim().to_lowercase();

    let row = sqlx::query_as::<_, (String, String, String, String, String, i32)>(
        "SELECT id, email, password_hash, full_name, role, is_pro FROM users WHERE email = $1"
    ).bind(&email).fetch_one(&state.pool).await;

    let (id, stored_email, hash, full_name, role, is_pro_int) = match row {
        Ok(r) => r,
        Err(_) => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid email or password" }))).into_response(),
    };

    let password = body.password.clone();
    let valid = tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash))
        .await.unwrap().unwrap_or(false);

    if !valid {
        return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid email or password" }))).into_response();
    }

    let token = Uuid::new_v4().to_string();
    let ts    = now_ms() as i64;

    let _ = sqlx::query(
        "INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)"
    ).bind(&token).bind(&id).bind(ts)
    .execute(&state.pool).await;

    let is_pro = is_pro_int != 0 || is_dev_account(&stored_email);
    (StatusCode::OK, Json(AuthResponse {
        token,
        user: UserResponse { id, email: stored_email, full_name, role, is_pro },
    })).into_response()
}

/// GET /api/auth/me
pub(crate) async fn handle_me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !legacy_auth_enabled() { return legacy_auth_disabled(); }
    let token = match extract_bearer(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing auth token" }))).into_response(),
    };

    let row = sqlx::query_as::<_, (String, String, String, String, i32)>(
        "SELECT u.id, u.email, u.full_name, u.role, u.is_pro
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = $1 AND s.created_at >= $2"
    ).bind(&token).bind(legacy_session_cutoff()).fetch_one(&state.pool).await;

    match row {
        Err(_) => (StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid or expired session" }))).into_response(),
        Ok((id, email, full_name, role, is_pro_int)) => {
            let is_pro = is_pro_int != 0 || is_dev_account(&email);
            (StatusCode::OK, Json(UserResponse {
                id, email, full_name, role, is_pro,
            })).into_response()
        }
    }
}

#[cfg(test)]
mod scope_tag_tests {
    use super::*;

    #[test]
    fn accepts_conventional_tags() {
        assert!(valid_scope_tag("env:prod"));
        assert!(valid_scope_tag("gpu"));
        assert!(valid_scope_tag("rack-2.us-east_1"));
    }

    #[test]
    fn rejects_commas_wildcards_and_empties() {
        // Commas would collide with the comma-separated nodes.tags storage;
        // % could game the SQL LIKE match; empty/oversized are nonsense.
        assert!(!valid_scope_tag(""));
        assert!(!valid_scope_tag("a,b"));
        assert!(!valid_scope_tag("100%"));
        assert!(!valid_scope_tag("has space"));
        assert!(!valid_scope_tag(&"x".repeat(65)));
    }
}

#[cfg(test)]
mod rbac_tests {
    use super::*;

    #[test]
    fn solo_users_are_admin_over_their_own_resources() {
        // No org in the session → full control; tenancy scoping confines them.
        assert_eq!(OrgRole::from_claim(None, false), OrgRole::Admin);
        // Even a stray role claim without an org doesn't demote a solo user.
        assert_eq!(OrgRole::from_claim(Some("org:viewer"), false), OrgRole::Admin);
    }

    #[test]
    fn clerk_role_claims_map_with_and_without_prefix() {
        // v1 tokens carry "org:admin"; v2 nested claims carry bare "admin".
        assert_eq!(OrgRole::from_claim(Some("org:admin"), true), OrgRole::Admin);
        assert_eq!(OrgRole::from_claim(Some("admin"), true), OrgRole::Admin);
        assert_eq!(OrgRole::from_claim(Some("org:member"), true), OrgRole::Member);
        assert_eq!(OrgRole::from_claim(Some("member"), true), OrgRole::Member);
        assert_eq!(OrgRole::from_claim(Some("org:viewer"), true), OrgRole::Viewer);
        assert_eq!(OrgRole::from_claim(Some("viewer"), true), OrgRole::Viewer);
    }

    #[test]
    fn unknown_org_roles_default_to_member_never_admin() {
        // A custom Clerk role must not be locked out of day-to-day work,
        // and must never be silently escalated to Admin.
        assert_eq!(OrgRole::from_claim(Some("org:ops_oncall"), true), OrgRole::Member);
        assert_eq!(OrgRole::from_claim(Some("basic_member"), true), OrgRole::Member);
        // Missing claim on an org session → Member (least privilege short of read-only).
        assert_eq!(OrgRole::from_claim(None, true), OrgRole::Member);
    }

    #[test]
    fn policy_table_viewer_reads_member_mutates_admin_deletes() {
        assert!(!OrgRole::Viewer.can_mutate());
        assert!(!OrgRole::Viewer.is_admin());
        assert!(OrgRole::Member.can_mutate());
        assert!(!OrgRole::Member.is_admin());
        assert!(OrgRole::Admin.can_mutate());
        assert!(OrgRole::Admin.is_admin());
    }
}

#[cfg(test)]
mod tenancy_tests {
    use super::*;

    #[test]
    fn tenant_scope_prefers_org_and_emits_only_safe_columns() {
        // org_id present → scope by the org column, bind the org value.
        let org = Some("org_abc".to_string());
        let (col, val) = tenant_scope("user_1", &org);
        assert_eq!(col, "org_id");
        assert_eq!(val, "org_abc");

        // No org → personal scope, excluding rows created inside an org.
        let none: Option<String> = None;
        let (col, val) = tenant_scope("user_1", &none);
        assert_eq!(col, "org_id IS NULL AND user_id");
        assert_eq!(val, "user_1");
    }

    #[test]
    fn tenant_scope_column_is_a_fixed_literal_not_caller_data() {
        // The column name feeds a format!() into SQL, so it must never reflect
        // caller-supplied text. Even an injection-shaped org value only ever
        // changes the BIND value, never the column literal.
        let evil = Some("org_x'; DROP TABLE nodes;--".to_string());
        let (col, val) = tenant_scope("user_1", &evil);
        assert_eq!(col, "org_id"); // literal, regardless of value
        assert_eq!(val, "org_x'; DROP TABLE nodes;--"); // safely bound as $1
    }
}
