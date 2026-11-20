//! Offline staging and adoption of legacy provider accounts. Unsupported
//! routing metadata is intentionally refused rather than silently discarded.
use crate::storage::StoredProviderNode;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::path::Path;
use zeroize::Zeroizing;

/// The native terminal availability status (the HTTP status the Rust
/// availability record keeps) for a terminal legacy `test_status`; transient
/// health states import with fresh availability.
fn terminal_status_code(status: Option<&str>) -> Result<Option<i64>, &'static str> {
    match status.map(str::trim) {
        None
        | Some(
            "" | "untested" | "success" | "active" | "unknown" | "unavailable" | "degraded"
            | "error" | "refreshing",
        ) => Ok(None),
        Some("expired") => Ok(Some(401)),
        Some("credits_exhausted") => Ok(Some(402)),
        Some("banned" | "deactivated") => Ok(Some(403)),
        Some(_) => Err("legacy provider health requires migration"),
    }
}

/// A legacy connection's `global_priority` is validated and dropped: the
/// legacy dashboard shows it as an "auto priority" badge, but no legacy
/// routing, selection or fallback path ever reads it (account order comes
/// from `priority`, which imports).
fn legacy_global_priority(value: Option<i64>) -> Result<(), &'static str> {
    match value {
        None | Some(0) => Ok(()),
        Some(priority) if (1..=100_000).contains(&priority) => Ok(()),
        Some(_) => Err("invalid legacy provider global priority"),
    }
}

/// A legacy connection's `max_concurrent`: zero or unset means no cap.
fn legacy_concurrency(value: Option<i64>) -> Result<Option<u32>, &'static str> {
    match value {
        None | Some(0) => Ok(None),
        Some(cap) => u32::try_from(cap)
            .ok()
            .filter(|cap| (1..=crate::storage::MAX_PROVIDER_CONCURRENCY).contains(cap))
            .map(Some)
            .ok_or("unsupported legacy provider concurrency"),
    }
}

/// Write an imported connection's concurrency cap for its first revision.
/// Legacy `rateLimitProtection` and `rateLimitOverrides` of a connection as
/// its native request queue policy, none when neither is set. Only positive
/// overrides count (legacy `resolveOverride`). An `executionMaxWaitMs` is
/// inert on the request path: the legacy limiter raises the backstop to the
/// upstream timeout, which the executor call already enforces.
fn legacy_queue_policy(
    protection: bool,
    overrides: Option<&str>,
) -> Result<Option<crate::request_queue::ConnectionQueuePolicy>, &'static str> {
    let record = match overrides.map(str::trim) {
        None | Some("" | "null" | "{}" | "[]") => serde_json::Map::new(),
        Some(text) => match serde_json::from_str::<serde_json::Value>(text) {
            Ok(serde_json::Value::Object(record)) => record,
            _ => return Err("invalid legacy provider rate limit overrides"),
        },
    };
    let positive = |name: &str| {
        record
            .get(name)
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 1.0)
            .map(|value| value.floor() as u64)
    };
    let policy = crate::request_queue::ConnectionQueuePolicy {
        protection,
        requests_per_minute: positive("rpm").map(|rpm| u32::try_from(rpm).unwrap_or(u32::MAX)),
        min_time_between_requests_ms: positive("minTime"),
        concurrent_requests: positive("maxConcurrent")
            .map(|count| u32::try_from(count).unwrap_or(u32::MAX)),
        max_wait_ms: positive("maxWaitMs"),
    };
    if !policy.valid() {
        return Err("invalid legacy provider rate limit overrides");
    }
    Ok((policy != crate::request_queue::ConnectionQueuePolicy::default()).then_some(policy))
}

/// Merge a connection's queue policy into the destination's global
/// `request_queue_connections` setting.
async fn record_imported_queue_policy(
    db: &mut SqliteConnection,
    id: &str,
    policy: Option<crate::request_queue::ConnectionQueuePolicy>,
) -> Result<(), &'static str> {
    let Some(policy) = policy else {
        return Ok(());
    };
    let key = crate::global_settings::REQUEST_QUEUE_CONNECTIONS;
    let stored: Option<(String, i64)> = sqlx::query_as(
        "SELECT value_json,revision FROM redrouter_control_global_settings WHERE setting_key=?",
    )
    .bind(key)
    .fetch_optional(&mut *db)
    .await
    .map_err(|_| "cannot read destination request queue policies")?;
    let (mut policies, revision) = match stored {
        Some((json, revision)) => (
            serde_json::from_str::<
                std::collections::BTreeMap<String, crate::request_queue::ConnectionQueuePolicy>,
            >(&json)
            .map_err(|_| "invalid destination request queue policies")?,
            revision,
        ),
        None => (std::collections::BTreeMap::new(), 0),
    };
    policies.insert(id.to_owned(), policy);
    let value = crate::global_settings::validate(
        key,
        serde_json::to_value(&policies).map_err(|_| "invalid request queue policies")?,
    )?;
    sqlx::query("INSERT INTO redrouter_control_global_settings (setting_key,value_json,revision) VALUES (?,?,?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision")
        .bind(key)
        .bind(serde_json::to_string(&value).map_err(|_| "invalid request queue policies")?)
        .bind(revision + 1)
        .execute(&mut *db)
        .await
        .map_err(|_| "cannot write request queue policies")?;
    Ok(())
}

async fn record_imported_concurrency(
    db: &mut SqliteConnection,
    id: &str,
    max_concurrent: Option<u32>,
) -> Result<(), &'static str> {
    let Some(cap) = max_concurrent else {
        return Ok(());
    };
    sqlx::query("INSERT INTO redrouter_control_provider_concurrency (record_id,provider_id,max_concurrent,revision) VALUES (?,?,?,1)")
        .bind(format!("{id}:1"))
        .bind(id)
        .bind(i64::from(cap))
        .execute(&mut *db)
        .await
        .map_err(|_| "cannot write provider concurrency")?;
    Ok(())
}

/// A legacy `rate_limited_until` still ahead of `now_ms`, as epoch
/// milliseconds. A past or unparseable value is cleared, as the legacy
/// startup sweep (`clearStaleCrashCooldowns`) does; a future one is kept,
/// since it can be a multi-day quota cooldown.
fn pending_cooldown_ms(value: Option<&str>, now_ms: i64) -> Option<i64> {
    let parsed = time::OffsetDateTime::parse(
        value?.trim(),
        &time::format_description::well_known::Rfc3339,
    )
    .ok()?;
    let until = i64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok()?;
    (until > now_ms).then_some(until)
}

fn unix_now_ms() -> Result<i64, &'static str> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .ok_or("invalid system clock")
}

/// Carry a connection's legacy health over as its native availability: a
/// terminal state, which only an operator reset clears, or else a pending
/// cooldown with the legacy backoff level.
async fn record_imported_availability(
    db: &mut SqliteConnection,
    id: &str,
    terminal: Option<i64>,
    cooldown_until_ms: Option<i64>,
    backoff_level: i64,
) -> Result<(), &'static str> {
    let (until, backoff, status) = match (terminal, cooldown_until_ms) {
        (Some(status), _) => (i64::MAX, 1, status),
        (None, Some(until)) => (until, backoff_level.clamp(1, 16), 429),
        (None, None) => return Ok(()),
    };
    sqlx::query("CREATE TABLE IF NOT EXISTS redrouter_provider_availability (provider_id TEXT PRIMARY KEY, cooldown_until_unix_ms BIGINT NOT NULL, backoff_level BIGINT NOT NULL, last_status BIGINT NOT NULL, model_lockouts_json TEXT NOT NULL, revision BIGINT NOT NULL)")
        .execute(&mut *db)
        .await
        .map_err(|_| "cannot initialize provider availability")?;
    sqlx::query("INSERT INTO redrouter_provider_availability (provider_id,cooldown_until_unix_ms,backoff_level,last_status,model_lockouts_json,revision) VALUES (?,?,?,?,'[]',1)")
        .bind(id)
        .bind(until)
        .bind(backoff)
        .bind(status)
        .execute(&mut *db)
        .await
        .map_err(|_| "cannot write provider availability")?;
    Ok(())
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

pub(crate) fn legacy_node_type(id: &str) -> &str {
    let Some((prefix, suffix)) = id.rsplit_once('-') else {
        return id;
    };
    if suffix.len() != 12 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return id;
    }
    let Some((prefix, group)) = prefix.rsplit_once('-') else {
        return id;
    };
    if group.len() != 4 || !group.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return id;
    }
    let Some((prefix, group)) = prefix.rsplit_once('-') else {
        return id;
    };
    if group.len() != 4 || !group.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return id;
    }
    let Some((prefix, group)) = prefix.rsplit_once('-') else {
        return id;
    };
    if group.len() != 4 || !group.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return id;
    }
    let Some((prefix, group)) = prefix.rsplit_once('-') else {
        return id;
    };
    if group.len() == 8 && group.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        prefix
    } else {
        id
    }
}

async fn compatible_node(
    target: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    legacy_provider: &str,
    tenant: &str,
) -> Result<StoredProviderNode, &'static str> {
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT config_json FROM redrouter_control_provider_nodes ORDER BY id",
    )
    .fetch_all(&mut **target)
    .await
    .map_err(|_| "destination provider definition schema unavailable")?;
    let mut candidates = Vec::new();
    for document in rows {
        let node: StoredProviderNode = serde_json::from_str(&document)
            .map_err(|_| "invalid destination provider definition")?;
        if node.tenant_id == tenant
            && (node.id == legacy_provider || legacy_node_type(&node.id) == legacy_provider)
        {
            candidates.push(node);
        }
    }
    if let Some(exact) = candidates.iter().find(|node| node.id == legacy_provider) {
        return Ok((*exact).clone());
    }
    match candidates.len() {
        1 => Ok(candidates.remove(0)),
        0 => Err("legacy provider transport is unsupported"),
        _ => Err("legacy provider definition is ambiguous"),
    }
}

#[derive(serde::Serialize)]
pub struct ProviderImport {
    pub imported: u64,
    pub enabled: bool,
    pub source_enabled: bool,
}

#[derive(serde::Serialize)]
pub struct ProviderStage {
    pub staged: u64,
}

/// Convert a staged Codex OAuth record into Rust-owned encrypted credentials.
/// It remains disabled, does not refresh tokens, and refuses routing settings
/// that have not yet been translated.
pub async fn adopt_codex(
    destination: &Path,
    id: &str,
    storage_key: &str,
    legacy_key: &str,
) -> Result<ProviderImport, &'static str> {
    adopt_oauth(destination, id, storage_key, legacy_key, "codex").await
}

/// Convert a staged Antigravity OAuth record without refreshing credentials.
pub async fn adopt_antigravity(
    destination: &Path,
    id: &str,
    storage_key: &str,
    legacy_key: &str,
) -> Result<ProviderImport, &'static str> {
    adopt_oauth(destination, id, storage_key, legacy_key, "agy").await
}

/// Convert a staged Claude Code OAuth record while preserving its persisted
/// device and account identity. The connection remains disabled until the
/// operator verifies it and explicitly enables it.
pub async fn adopt_claude(
    destination: &Path,
    id: &str,
    storage_key: &str,
    legacy_key: &str,
) -> Result<ProviderImport, &'static str> {
    adopt_oauth(destination, id, storage_key, legacy_key, "claude").await
}

/// Preserve a staged xAI OAuth session without contacting the provider.
pub async fn adopt_xai(
    destination: &Path,
    id: &str,
    storage_key: &str,
    legacy_key: &str,
) -> Result<ProviderImport, &'static str> {
    adopt_oauth(destination, id, storage_key, legacy_key, "xai-oauth").await
}

/// Preserve a staged Openference OAuth session without contacting the provider.
pub async fn adopt_openference(
    destination: &Path,
    id: &str,
    storage_key: &str,
    legacy_key: &str,
) -> Result<ProviderImport, &'static str> {
    adopt_oauth(destination, id, storage_key, legacy_key, "openference").await
}

/// Adopt GitHub sessions only when the GitHub token can refresh Copilot directly.
pub async fn adopt_github(
    destination: &Path,
    id: &str,
    storage_key: &str,
    legacy_key: &str,
) -> Result<ProviderImport, &'static str> {
    adopt_oauth(destination, id, storage_key, legacy_key, "github").await
}

async fn adopt_oauth(
    destination: &Path,
    id: &str,
    storage_key: &str,
    legacy_key: &str,
    provider: &str,
) -> Result<ProviderImport, &'static str> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid provider identifier");
    }
    if !(16..=512).contains(&storage_key.len()) || !(16..=512).contains(&legacy_key.len()) {
        return Err("invalid storage encryption key");
    }
    let path =
        std::fs::canonicalize(destination).map_err(|_| "destination database does not exist")?;
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path))
        .await
        .map_err(|_| "cannot open destination database")?;
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut db)
        .await
        .map_err(|_| "cannot initialize destination database")?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut db)
        .await
        .map_err(|_| "cannot start OAuth adoption")?;
    let result: Result<ProviderImport, &'static str> = async {
        let ciphertext: String = sqlx::query_scalar("SELECT encrypted_record FROM redrouter_legacy_provider_records WHERE provider_id=?")
            .bind(id).fetch_optional(&mut db).await.map_err(|_| "staged provider unavailable")?.ok_or("staged provider unavailable")?;
        let plaintext = crate::control_plane::decrypt(&ciphertext, &format!("legacy-provider-stage:{id}"), storage_key)?;
        let record: serde_json::Value = serde_json::from_str(&plaintext).map_err(|_| "invalid staged provider")?;
        let object = record.as_object().ok_or("invalid staged provider")?;
        let text = |name: &str| -> Result<Option<&str>, &'static str> {
            match object.get(name) { Some(serde_json::Value::Null) => Ok(None), Some(serde_json::Value::String(value)) => Ok(Some(value)), _ => Err("unsupported staged provider schema") }
        };
        if text("id")? != Some(id) || text("provider")? != Some(provider) || text("auth_type")? != Some("oauth") { return Err("staged provider is not the expected OAuth session"); }
        let active = match object.get("is_active").and_then(serde_json::Value::as_i64) { Some(0) => false, Some(1) => true, _ => return Err("invalid staged provider status") };
        let priority = match object.get("priority") {
            Some(serde_json::Value::Null) => 0,
            Some(value) => value.as_i64().filter(|value| crate::control_plane::valid_provider_priority(*value)).ok_or("invalid legacy provider priority")?,
            None => return Err("unsupported staged provider schema"),
        };
        legacy_global_priority(match object.get("global_priority") {
            None | Some(serde_json::Value::Null) => None,
            Some(value) => Some(value.as_i64().ok_or("invalid legacy provider global priority")?),
        })?;
        for field in ["per_key_proxy_enabled", "proxy_enabled", "rate_limit_protection"] {
            match object.get(field) { Some(serde_json::Value::Null) => {}, Some(value) if value.as_i64() == Some(0) => {}, _ => return Err("legacy provider policy requires migration") }
        }
        let max_concurrent = legacy_concurrency(match object.get("max_concurrent") {
            None | Some(serde_json::Value::Null) => None,
            Some(value) => Some(value.as_i64().ok_or("invalid legacy provider concurrency")?),
        })?;
        // The backoff level and a pending cooldown are runtime health; a
        // future cooldown carries over (see pending_cooldown_ms).
        let backoff_level = match object.get("backoff_level") {
            None | Some(serde_json::Value::Null) => 0,
            Some(value) => value.as_i64().filter(|level| *level >= 0).ok_or("invalid legacy provider backoff")?,
        };
        let cooldown_until = pending_cooldown_ms(text("rate_limited_until")?, unix_now_ms()?);
        for field in ["quota_window_thresholds_json", "rate_limit_overrides_json"] {
            if text(field)?.is_some_and(|value| !matches!(value.trim(), "" | "null" | "{}" | "[]")) { return Err("legacy provider policy requires migration"); }
        }
        let default_model = text("default_model")?.filter(|value| !value.is_empty());
        if default_model.is_some_and(|value| !crate::control_plane::model_aliases::valid_model_name(value)) { return Err("invalid legacy provider default model"); }
        // A transient cooldown (rate_limited_until) and the last error's
        // diagnostics are runtime health, not configuration: the adopted
        // connection starts with fresh availability state.
        for field in ["group", "api_key"] {
            if text(field)?.is_some_and(|value| !value.trim().is_empty()) { return Err("legacy provider configuration requires migration"); }
        }
        let terminal = terminal_status_code(text("test_status")?)?;
        let tenant = text("tenant_id")?.ok_or("legacy provider tenant is missing")?;
        let tenant_exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_tenants WHERE id=? AND enabled=1").bind(tenant).fetch_one(&mut db).await.map_err(|_| "destination tenant unavailable")?;
        if tenant_exists != 1 { return Err("legacy provider tenant is unavailable"); }
        for table in ["redrouter_control_providers", "redrouter_control_provider_ownership", "redrouter_control_provider_auth", "redrouter_control_provider_oauth", "redrouter_control_provider_sessions", "redrouter_control_provider_priorities", "redrouter_control_provider_defaults", "redrouter_control_provider_oauth_status", "redrouter_provider_resilience", "redrouter_provider_quotas", "redrouter_provider_model_quotas", "redrouter_provider_breakers", "redrouter_provider_breaker_overrides", "redrouter_provider_availability", "redrouter_provider_model_rules"] {
            let column = if table == "redrouter_control_providers" { "id" } else { "provider_id" };
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM \"{table}\" WHERE \"{column}\"=?")).bind(id).fetch_one(&mut db).await.map_err(|_| "destination provider schema unavailable")?;
            if count != 0 { return Err("destination provider already exists"); }
        }
        let token = |name| -> Result<Zeroizing<String>, &'static str> {
            let stored = text(name)?.filter(|value| !value.is_empty()).ok_or("legacy OAuth token is missing")?;
            crate::product::decrypt(stored, Some(legacy_key))
        };
        let access = token("access_token")?;
        let refresh = if provider == "github" {
            if text("refresh_token")?.is_some_and(|value| !value.is_empty()) { return Err("legacy GitHub token renewal requires migration"); }
            Zeroizing::new(access.to_string())
        } else {
            token("refresh_token")?
        };
        let mut specific: serde_json::Value = match text("provider_specific_data")? {
            None | Some("") => serde_json::json!({}),
            Some(value) => serde_json::from_str(value).map_err(|_| "invalid legacy OAuth metadata")?,
        };
        let specific = specific.as_object_mut().ok_or("invalid legacy OAuth metadata")?;
        let model_rules = crate::control_plane::provider_rules::take_legacy(specific)?;
        let (access, refresh, session, parsed_expiry, parsed_email, upstream) = if provider == "codex" {
            let id_token = token("id_token")?;
            let parsed = crate::control_plane::parse_codex_auth(serde_json::json!({"auth_mode":"chatgpt", "tokens": {"access_token":access.as_str(),"refresh_token":refresh.as_str(),"id_token":id_token.as_str()}}))?;
            if specific.keys().any(|key| !matches!(key.as_str(), "workspaceId" | "workspacePlanType" | "chatgptUserId" | "organizations" | "autoSync")) { return Err("legacy Codex configuration requires migration"); }
            match specific.get("autoSync") {
                None | Some(serde_json::Value::Null) | Some(serde_json::Value::Bool(false)) => {},
                Some(serde_json::Value::Bool(true)) => return Err("legacy model auto-sync requires migration"),
                _ => return Err("invalid legacy model auto-sync setting"),
            }
            if let Some(workspace) = specific.get("workspaceId").filter(|value| !value.is_null()) {
                if workspace.as_str() != Some(parsed.account_id.as_str()) { return Err("legacy Codex workspace requires reconciliation"); }
            }
            if let Some(user) = specific.get("chatgptUserId").filter(|value| !value.is_null()) {
                if user.as_str() != parsed.user_id.as_deref() { return Err("legacy Codex user requires reconciliation"); }
            }
            let mut session: serde_json::Value = serde_json::from_str(parsed.session_metadata.as_str()).map_err(|_| "invalid Codex metadata")?;
            session["legacyCodex"] = serde_json::Value::Object(specific.clone());
            let session = Zeroizing::new(session.to_string());
            if session.len() > 65_536 { return Err("legacy Codex identity is too large"); }
            (parsed.access_token, parsed.refresh_token, session, parsed.expires_at_unix, parsed.email, crate::control_plane::CODEX_PROVIDER_URL)
        } else if provider == "claude" {
            if text("id_token")?.is_some_and(|value| !value.is_empty()) { return Err("legacy Claude identity token requires migration"); }
            let allowed = ["accountUUID", "organizationUUID", "organizationName", "organizationType", "rateLimitTier", "scopes", "subscriptionType", "bootstrapEmail", "importedAt", "cliUserID", "userID"];
            if specific.keys().any(|key| !allowed.contains(&key.as_str())) { return Err("legacy Claude configuration requires migration"); }
            let account = specific.get("accountUUID").and_then(serde_json::Value::as_str).filter(|value| valid_uuid(value)).ok_or("legacy Claude account identity is missing")?;
            let device = specific.get("cliUserID").or_else(|| specific.get("userID")).and_then(serde_json::Value::as_str)
                .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .ok_or("legacy Claude device identity is missing")?;
            let expiry = text("token_expires_at")?.filter(|value| !value.is_empty()).or(text("expires_at")?.filter(|value| !value.is_empty())).ok_or("legacy OAuth expiry is missing")?;
            let scopes = match specific.get("scopes") {
                None | Some(serde_json::Value::Null) => text("scope")?.map(|scope| scope.split_whitespace().map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default(),
                Some(serde_json::Value::Array(values)) => values.iter().map(|value| value.as_str().map(str::to_owned).ok_or("invalid legacy Claude scopes")).collect::<Result<Vec<_>, _>>()?,
                Some(_) => return Err("invalid legacy Claude scopes"),
            };
            let parsed = crate::control_plane::parse_claude_auth(serde_json::json!({"claudeAiOauth":{
                "accessToken":access.as_str(),"refreshToken":refresh.as_str(),"expiresAt":expiry,"scopes":scopes,
                "subscriptionType":specific.get("subscriptionType"),"rateLimitTier":specific.get("rateLimitTier")
            }}))?;
            let mut metadata: serde_json::Value = serde_json::from_str(parsed.session_metadata.as_str()).map_err(|_| "invalid Claude metadata")?;
            metadata["accountUUID"] = serde_json::Value::String(account.to_ascii_lowercase());
            metadata["cliUserID"] = serde_json::Value::String(device.to_ascii_lowercase());
            metadata["legacyClaude"] = serde_json::Value::Object(specific.clone());
            let session = Zeroizing::new(metadata.to_string());
            if session.len() > 65_536 { return Err("legacy Claude identity is too large"); }
            let email = specific.get("bootstrapEmail").and_then(serde_json::Value::as_str).filter(|value| !value.trim().is_empty()).map(str::to_owned);
            (parsed.access_token, parsed.refresh_token, session, parsed.expires_at_unix, email, crate::control_plane::CLAUDE_PROVIDER_URL)
        } else if provider == "github" {
            if text("id_token")?.is_some_and(|value| !value.is_empty()) || text("project_id")?.is_some_and(|value| !value.trim().is_empty()) { return Err("legacy GitHub identity requires migration"); }
            if text("token_type")?.is_some_and(|value| !value.is_empty() && !value.eq_ignore_ascii_case("bearer")) { return Err("unsupported legacy GitHub token type"); }
            if specific.keys().any(|key| !matches!(key.as_str(), "autoSync" | "copilotToken" | "copilotTokenExpiresAt" | "githubUserId" | "githubLogin" | "githubName" | "githubEmail")) { return Err("legacy GitHub configuration requires migration"); }
            match specific.get("autoSync") {
                None | Some(serde_json::Value::Null) | Some(serde_json::Value::Bool(false)) => {},
                Some(serde_json::Value::Bool(true)) => return Err("legacy model auto-sync requires migration"),
                _ => return Err("invalid legacy model auto-sync setting"),
            }
            let github_token = refresh;
            if !(1..=8192).contains(&github_token.len()) || reqwest::header::HeaderValue::from_str(github_token.as_str()).is_err() { return Err("invalid legacy GitHub token"); }
            let stored_copilot = specific.remove("copilotToken").and_then(|value| value.as_str().map(str::to_owned)).filter(|value| !value.is_empty()).ok_or("legacy Copilot token is missing")?;
            let copilot = crate::product::decrypt(&Zeroizing::new(stored_copilot), Some(legacy_key))?;
            if !(1..=8192).contains(&copilot.len()) || reqwest::header::HeaderValue::from_str(copilot.as_str()).is_err() { return Err("invalid legacy Copilot token"); }
            let expiry = match specific.get("copilotTokenExpiresAt") {
                Some(serde_json::Value::Number(value)) => {
                    let value = value.as_u64().filter(|value| *value > 0).ok_or("invalid legacy Copilot expiry")?;
                    if value < 1_000_000_000_000 { value } else { value / 1000 }
                }
                Some(serde_json::Value::String(value)) => {
                    let value = time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).map_err(|_| "invalid legacy Copilot expiry")?.unix_timestamp();
                    u64::try_from(value).map_err(|_| "invalid legacy Copilot expiry")?
                }
                _ => return Err("legacy Copilot expiry is missing"),
            };
            let scope = text("scope")?.filter(|value| !value.is_empty());
            if scope.is_some_and(|value| value.len() > 4096 || value.chars().any(char::is_control)) { return Err("invalid legacy GitHub scope"); }
            let session = Zeroizing::new(serde_json::json!({"scope":scope,"github":specific}).to_string());
            if session.len() > 65_536 { return Err("legacy GitHub identity is too large"); }
            (copilot, github_token, session, expiry, None, "https://api.githubcopilot.com/chat/completions")
        } else if matches!(provider, "xai-oauth" | "openference") {
            if !(1..=8192).contains(&access.len()) || !(1..=8192).contains(&refresh.len()) || reqwest::header::HeaderValue::from_str(access.as_str()).is_err() { return Err("invalid legacy OAuth credentials"); }
            if specific.keys().any(|key| !matches!(key.as_str(), "scope" | "tokenType")) { return Err("legacy OAuth configuration requires migration"); }
            if text("project_id")?.is_some_and(|value| !value.trim().is_empty()) { return Err("legacy OAuth project requires migration"); }
            let optional_metadata = |key: &str| -> Result<Option<&str>, &'static str> {
                match specific.get(key) {
                    None | Some(serde_json::Value::Null) => Ok(None),
                    Some(serde_json::Value::String(value)) if value.len() <= 4096 && !value.chars().any(char::is_control) => Ok(Some(value)),
                    _ => Err("invalid legacy OAuth metadata"),
                }
            };
            let nested_scope = optional_metadata("scope")?.filter(|value| !value.is_empty());
            let direct_scope = text("scope")?.filter(|value| !value.is_empty());
            if direct_scope.is_some_and(|value| value.len() > 4096 || value.chars().any(char::is_control)) { return Err("invalid legacy OAuth scope"); }
            if direct_scope.is_some() && nested_scope.is_some() && direct_scope != nested_scope { return Err("legacy OAuth scope requires reconciliation"); }
            let nested_type = optional_metadata("tokenType")?.filter(|value| !value.is_empty());
            let direct_type = text("token_type")?.filter(|value| !value.is_empty());
            if direct_type.is_some_and(|value| !value.eq_ignore_ascii_case("bearer")) || nested_type.is_some_and(|value| !value.eq_ignore_ascii_case("bearer")) { return Err("unsupported legacy OAuth token type"); }
            let id_token = match text("id_token")?.filter(|value| !value.is_empty()) {
                Some(value) => Some(crate::product::decrypt(value, Some(legacy_key))?),
                None => None,
            };
            if id_token.as_ref().is_some_and(|value| value.len() > 8192 || value.chars().any(char::is_control)) { return Err("invalid legacy OAuth identity token"); }
            let expiry = text("token_expires_at")?.filter(|value| !value.is_empty()).or(text("expires_at")?.filter(|value| !value.is_empty())).ok_or("legacy OAuth expiry is missing")?;
            let expiry = time::OffsetDateTime::parse(expiry, &time::format_description::well_known::Rfc3339).map_err(|_| "invalid legacy OAuth expiry")?.unix_timestamp();
            let expiry = u64::try_from(expiry).map_err(|_| "invalid legacy OAuth expiry")?;
            let session = Zeroizing::new(serde_json::json!({"scope":direct_scope.or(nested_scope),"tokenType":"Bearer","idToken":id_token.as_deref().map(|value| value.as_str())}).to_string());
            let upstream = if provider == "xai-oauth" { crate::control_plane::XAI_PROVIDER_URL } else { crate::control_plane::OPENFERENCE_PROVIDER_URL };
            (access, refresh, session, expiry, None, upstream)
        } else {
            if text("id_token")?.is_some_and(|value| !value.is_empty()) { return Err("legacy Antigravity identity token requires migration"); }
            if text("scope")?.is_some_and(|value| !value.trim().is_empty()) { return Err("legacy Antigravity OAuth scope requires migration"); }
            if specific.keys().any(|key| !matches!(key.as_str(), "projectId" | "clientProfile" | "authMethod" | "tokenType")) { return Err("legacy Antigravity configuration requires migration"); }
            if specific.get("clientProfile").is_some_and(|value| !value.is_null() && value.as_str() != Some("cli")) { return Err("legacy Antigravity client profile requires migration"); }
            let direct = text("project_id")?.filter(|value| !value.trim().is_empty());
            let nested = match specific.get("projectId") { None | Some(serde_json::Value::Null) => None, Some(value) => Some(value.as_str().ok_or("invalid Antigravity project")?).filter(|value| !value.trim().is_empty()) };
            if direct.is_some() && nested.is_some() && direct != nested { return Err("legacy Antigravity project requires reconciliation"); }
            let project = direct.or(nested).filter(|value| value.len() <= 256 && value.trim() == *value && *value != "__REQUIRES_GCP_PROJECT__" && !value.chars().any(char::is_control)).ok_or("legacy Antigravity project is missing")?;
            let expiry = text("token_expires_at")?.filter(|value| !value.is_empty()).or(text("expires_at")?.filter(|value| !value.is_empty())).ok_or("legacy OAuth expiry is missing")?;
            let token_type = text("token_type")?.filter(|value| !value.is_empty()).unwrap_or("Bearer");
            if let Some(value) = specific.get("tokenType").filter(|value| !value.is_null()) {
                if !value.as_str().is_some_and(|value| value.eq_ignore_ascii_case(token_type)) { return Err("legacy Antigravity token type requires reconciliation"); }
            }
            let parsed = crate::control_plane::parse_agy_auth(serde_json::json!({"access_token":access.as_str(),"refresh_token":refresh.as_str(),"expiry":expiry,"token_type":token_type,"auth_method":specific.get("authMethod")}))?;
            let metadata: serde_json::Value = serde_json::from_str(parsed.session_metadata.as_str()).map_err(|_| "invalid Antigravity metadata")?;
            let session = Zeroizing::new(serde_json::json!({"clientProfile":"cli","tokenType":metadata["tokenType"],"authMethod":metadata["authMethod"],"projectId":project}).to_string());
            (parsed.access_token, parsed.refresh_token, session, parsed.expires_at_unix, None, crate::control_plane::AGY_PROVIDER_URL)
        };
        let mut expires = i64::try_from(parsed_expiry).map_err(|_| "invalid legacy OAuth expiry")?;
        if expires <= 0 { return Err("invalid legacy OAuth expiry"); }
        for field in ["expires_at", "token_expires_at"] {
            if let Some(value) = text(field)?.filter(|value| !value.trim().is_empty()) {
                let parsed = time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).map_err(|_| "invalid legacy OAuth expiry")?;
                let candidate = parsed.unix_timestamp();
                if candidate <= 0 { return Err("invalid legacy OAuth expiry"); }
                expires = expires.min(candidate);
            }
        }
        let label = text("display_name")?.filter(|value| !value.trim().is_empty()).or(text("name")?.filter(|value| !value.trim().is_empty())).unwrap_or(id).trim();
        let email = text("email")?.filter(|value| !value.trim().is_empty()).or(parsed_email.as_deref()).unwrap_or("").trim();
        if crate::control_plane::validate_provider_label(label).is_err() || email.len() > 320 || email.chars().any(char::is_control) { return Err("invalid legacy provider identity"); }
        let access_cipher = crate::control_plane::encrypt(access.as_str(), id, storage_key)?;
        let refresh_cipher = crate::control_plane::encrypt(refresh.as_str(), &format!("{id}:oauth-refresh"), storage_key)?;
        let session_cipher = crate::control_plane::encrypt(session.as_str(), &format!("{id}:oauth-session"), storage_key)?;
        sqlx::query("CREATE TABLE IF NOT EXISTS redrouter_legacy_provider_migration (provider_id TEXT PRIMARY KEY,source_enabled BIGINT NOT NULL)").execute(&mut db).await.map_err(|_| "cannot initialize provider migration state")?;
        sqlx::query("INSERT INTO redrouter_legacy_provider_migration VALUES (?,?)").bind(id).bind(i64::from(active)).execute(&mut db).await.map_err(|_| "provider migration state already exists")?;
        sqlx::query("INSERT INTO redrouter_control_providers VALUES (?,?,?,?,0,1)").bind(id).bind(provider).bind(upstream).bind(access_cipher).execute(&mut db).await.map_err(|_| "cannot write OAuth provider")?;
        record_imported_availability(&mut db, id, terminal, cooldown_until, backoff_level).await?;
        record_imported_concurrency(&mut db, id, max_concurrent).await?;
        if priority != 0 {
            sqlx::query("INSERT INTO redrouter_control_provider_priorities (record_id,provider_id,account_rank,revision) VALUES (?,?,?,1)").bind(format!("{id}:1")).bind(id).bind(priority).execute(&mut db).await.map_err(|_| "cannot write provider priority")?;
        }
        if let Some(model) = default_model {
            sqlx::query("INSERT INTO redrouter_control_provider_defaults (record_id,provider_id,model_name,revision) VALUES (?,?,?,1)").bind(format!("{id}:1")).bind(id).bind(model).execute(&mut db).await.map_err(|_| "cannot write provider default model")?;
        }
        sqlx::query("INSERT INTO redrouter_control_provider_ownership VALUES (?,?,1)").bind(id).bind(tenant).execute(&mut db).await.map_err(|_| "cannot write provider ownership")?;
        if !model_rules.is_empty() {
            let json = serde_json::to_string(&model_rules).map_err(|_| "invalid legacy model exclusions")?;
            sqlx::query("INSERT INTO redrouter_provider_model_rules(provider_id,tenant_id,patterns_json,revision) VALUES (?,?,?,1)")
                .bind(id).bind(tenant).bind(json).execute(&mut db).await.map_err(|_| "cannot preserve legacy model exclusions")?;
        }
        sqlx::query("INSERT INTO redrouter_control_provider_auth VALUES (?,?,'bearer',?,?,?,1)").bind(format!("{id}:1")).bind(id).bind(label).bind(email).bind(expires).execute(&mut db).await.map_err(|_| "cannot write provider identity")?;
        sqlx::query("INSERT INTO redrouter_control_provider_oauth VALUES (?,?,?,0,1)").bind(id).bind(provider).bind(refresh_cipher).execute(&mut db).await.map_err(|_| "cannot write OAuth refresh token")?;
        sqlx::query("INSERT INTO redrouter_control_provider_sessions VALUES (?,?,?,1)").bind(id).bind(provider).bind(session_cipher).execute(&mut db).await.map_err(|_| "cannot write OAuth session")?;
        let scope = if matches!(provider, "github" | "xai-oauth" | "openference") { "model" } else { "connection" };
        sqlx::query("INSERT INTO redrouter_provider_resilience VALUES (?,?,?,1)").bind(format!("{id}:1")).bind(id).bind(scope).execute(&mut db).await.map_err(|_| "cannot write provider resilience")?;
        Ok(ProviderImport { imported: 1, enabled: false, source_enabled: active })
    }.await;
    match result {
        Ok(report) => {
            sqlx::query("COMMIT")
                .execute(&mut db)
                .await
                .map_err(|_| "cannot commit OAuth adoption")?;
            Ok(report)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut db).await;
            Err(error)
        }
    }
}

/// Stage every complete provider row, including OAuth tokens and provider-
/// specific metadata, in a Rust-encrypted envelope. No staged row is activated
/// or interpreted as a supported provider configuration.
pub async fn stage(
    source: &Path,
    destination: &Path,
    storage_key: &str,
) -> Result<ProviderStage, &'static str> {
    use futures_util::TryStreamExt;
    if !(16..=512).contains(&storage_key.len()) {
        return Err("invalid storage encryption key");
    }
    let source = std::fs::canonicalize(source).map_err(|_| "legacy database does not exist")?;
    let destination =
        std::fs::canonicalize(destination).map_err(|_| "destination database does not exist")?;
    if source == destination {
        return Err("legacy and destination databases must be different files");
    }
    let mut input = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(source).read_only(true),
    )
    .await
    .map_err(|_| "cannot open legacy database read-only")?;
    sqlx::query("PRAGMA query_only = ON")
        .execute(&mut input)
        .await
        .map_err(|_| "cannot initialize legacy database")?;
    sqlx::query("PRAGMA trusted_schema = OFF")
        .execute(&mut input)
        .await
        .map_err(|_| "cannot initialize legacy database")?;
    let mut output =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(destination))
            .await
            .map_err(|_| "cannot open destination database")?;
    let result = async {
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut output)
        .await
        .map_err(|_| "cannot initialize destination database")?;
    let mut snapshot = input
        .begin()
        .await
        .map_err(|_| "cannot start legacy snapshot")?;
    let mut target = output
        .begin()
        .await
        .map_err(|_| "cannot start provider staging")?;
    let result: Result<ProviderStage, &'static str> = async {
        let mixed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='provider_connections'").fetch_one(&mut *target).await.map_err(|_| "cannot inspect destination schema")?;
        if mixed != 0 { return Err("destination contains legacy tables; use a separate Rust database"); }
        let definition: Option<String> = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_connections'").fetch_optional(&mut *snapshot).await.map_err(|_| "cannot inspect legacy provider schema")?;
        let definition = definition.ok_or("legacy provider schema unavailable")?;
        if definition.to_ascii_uppercase().contains("VIRTUAL TABLE") { return Err("unsupported legacy provider schema"); }
        let columns = sqlx::query("PRAGMA table_xinfo('provider_connections')").fetch_all(&mut *snapshot).await.map_err(|_| "cannot inspect legacy provider schema")?;
        // SQLite builds can limit json_object to 127 arguments.
        if columns.is_empty() || columns.len() > 60 { return Err("unsupported legacy provider schema"); }
        let mut names = Vec::with_capacity(columns.len());
        for column in columns {
            let name: String = column.try_get("name").map_err(|_| "invalid legacy provider schema")?;
            let hidden: i64 = column.try_get("hidden").map_err(|_| "invalid legacy provider schema")?;
            if hidden != 0 || name.is_empty() || name.len() > 256 { return Err("unsupported legacy provider schema"); }
            names.push(name);
        }
        if !names.iter().any(|name| name == "id") { return Err("legacy provider identifier is missing"); }
        let quoted = |name: &str| format!("\"{}\"", name.replace('"', "\"\""));
        let invalid = names.iter().map(|name| format!("typeof({}) NOT IN ('null','integer','text')", quoted(name))).collect::<Vec<_>>().join(" OR ");
        let unsupported: i64 = sqlx::query_scalar(&format!("SELECT EXISTS(SELECT 1 FROM provider_connections WHERE {invalid} LIMIT 1)"))
            .fetch_one(&mut *snapshot).await.map_err(|_| "cannot inspect legacy provider values")?;
        if unsupported != 0 { return Err("unsupported legacy provider value type"); }
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name='redrouter_legacy_provider_records'").fetch_one(&mut *target).await.map_err(|_| "cannot inspect provider staging state")?;
        if exists != 0 { return Err("legacy provider staging already exists; nothing overwritten"); }
        sqlx::query("CREATE TABLE redrouter_legacy_provider_records (provider_id TEXT PRIMARY KEY, encrypted_record TEXT NOT NULL)")
            .execute(&mut *target).await.map_err(|_| "cannot initialize provider staging")?;
        let pairs = names.iter().map(|name| format!("?,{}", quoted(name))).collect::<Vec<_>>().join(",");
        let statement = format!("SELECT id,json_object({pairs}) AS record FROM provider_connections");
        let mut query = sqlx::query(&statement);
        for name in &names { query = query.bind(name); }
        let mut rows = query.fetch(&mut *snapshot);
        let mut staged = 0u64;
        while let Some(row) = rows.try_next().await.map_err(|_| "cannot read legacy provider records")? {
            if staged >= 10_000 { return Err("too many legacy provider records"); }
            let id: String = row.try_get("id").map_err(|_| "invalid legacy provider identifier")?;
            if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) { return Err("invalid legacy provider identifier"); }
            let record = Zeroizing::new(row.try_get::<String, _>("record").map_err(|_| "invalid legacy provider record")?);
            if record.len() > 1_048_576 { return Err("legacy provider record is too large"); }
            let ciphertext = crate::control_plane::encrypt(&record, &format!("legacy-provider-stage:{id}"), storage_key)?;
            sqlx::query("INSERT INTO redrouter_legacy_provider_records (provider_id,encrypted_record) VALUES (?,?)")
                .bind(&id).bind(ciphertext).execute(&mut *target).await.map_err(|_| "cannot stage legacy provider record")?;
            staged += 1;
        }
        Ok(ProviderStage { staged })
    }.await;
    match result {
        Ok(report) => {
            snapshot
                .commit()
                .await
                .map_err(|_| "cannot finish legacy snapshot")?;
            target
                .commit()
                .await
                .map_err(|_| "cannot commit provider staging")?;
            Ok(report)
        }
        Err(error) => {
            let _ = target.rollback().await;
            let _ = snapshot.rollback().await;
            Err(error)
        }
    }
    }.await;
    let output_close = output.close().await;
    let input_close = input.close().await;
    if output_close.is_err() || input_close.is_err() {
        return Err("cannot close migration database");
    }
    result
}

pub async fn import(
    source: &Path,
    destination: &Path,
    id: &str,
    storage_key: &str,
) -> Result<ProviderImport, &'static str> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid provider identifier");
    }
    if !(16..=512).contains(&storage_key.len()) {
        return Err("invalid storage encryption key");
    }
    let source = std::fs::canonicalize(source).map_err(|_| "legacy database does not exist")?;
    let destination =
        std::fs::canonicalize(destination).map_err(|_| "destination database does not exist")?;
    if source == destination {
        return Err("legacy and destination databases must be different files");
    }
    let mut input = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(source).read_only(true),
    )
    .await
    .map_err(|_| "cannot open legacy database read-only")?;
    sqlx::query("PRAGMA query_only = ON")
        .execute(&mut input)
        .await
        .map_err(|_| "cannot initialize legacy database")?;
    let mut output =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(destination))
            .await
            .map_err(|_| "cannot open destination database")?;
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut output)
        .await
        .map_err(|_| "cannot initialize destination database")?;
    let mut snapshot = input
        .begin()
        .await
        .map_err(|_| "cannot start legacy snapshot")?;
    let mut target = output
        .begin()
        .await
        .map_err(|_| "cannot start provider import")?;
    let result: Result<ProviderImport, &'static str> = async {
        // Prevent same-file hard links as well as intentionally mixed databases.
        let mixed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='provider_connections'").fetch_one(&mut *target).await.map_err(|_| "cannot inspect destination schema")?;
        if mixed != 0 { return Err("destination contains legacy tables; use a separate Rust database"); }
        let row = sqlx::query("SELECT * FROM provider_connections WHERE id=?")
            .bind(id).fetch_optional(&mut *snapshot).await.map_err(|_| "unsupported legacy provider schema")?.ok_or("legacy provider not found")?;
        let text = |field: &str| row.try_get::<Option<String>, _>(field).map_err(|_| "invalid legacy provider");
        let number = |field: &str| row.try_get::<Option<i64>, _>(field).map_err(|_| "invalid legacy provider");
        let provider = text("provider")?.ok_or("invalid legacy provider")?;
        if text("auth_type")?.as_deref() != Some("apikey") { return Err("legacy OAuth or provider authentication requires migration"); }
        let source_enabled = match number("is_active")? { Some(0) => false, Some(1) => true, _ => return Err("invalid legacy provider status") };
        // rate_limited_until is a transient cooldown; the imported (disabled)
        // connection starts with fresh availability state.
        for field in ["access_token", "refresh_token", "id_token", "expires_at", "token_expires_at", "scope", "project_id", "group"] {
            if text(field)?.is_some_and(|value| !value.trim().is_empty()) { return Err("legacy provider metadata requires migration"); }
        }
        let default_model = text("default_model")?.filter(|value| !value.is_empty());
        if default_model.as_deref().is_some_and(|value| !crate::control_plane::model_aliases::valid_model_name(value)) { return Err("invalid legacy provider default model"); }
        let model_rules = crate::control_plane::provider_rules::parse_legacy(text("provider_specific_data")?.as_deref())?;
        if text("quota_window_thresholds_json")?.is_some_and(|value| !matches!(value.trim(), "" | "null" | "{}" | "[]")) { return Err("legacy provider configuration requires migration"); }
        let rate_limit_overrides = match row.try_get::<Option<String>, _>("rate_limit_overrides_json") {
            Ok(value) => value,
            Err(sqlx::Error::ColumnNotFound(_)) => None,
            Err(_) => return Err("invalid legacy provider"),
        };
        let max_concurrent = legacy_concurrency(number("max_concurrent")?)?;
        for field in ["per_key_proxy_enabled", "proxy_enabled"] {
            if number(field)?.unwrap_or(0) != 0 { return Err("legacy provider policy requires migration"); }
        }
        // Older schemas omit these columns. When present, never silently drop
        // account selection/admission policy merely because the API key imports.
        let priority = match row.try_get::<Option<i64>, _>("priority") {
            Ok(value) => value.unwrap_or(0),
            Err(sqlx::Error::ColumnNotFound(_)) => 0,
            Err(_) => return Err("invalid legacy provider priority"),
        };
        if !crate::control_plane::valid_provider_priority(priority) { return Err("invalid legacy provider priority"); }
        // The backoff level and a pending cooldown are runtime health; a
        // future cooldown carries over (see pending_cooldown_ms).
        let backoff_level = match row.try_get::<Option<i64>, _>("backoff_level") {
            Ok(None) | Err(sqlx::Error::ColumnNotFound(_)) => 0,
            Ok(Some(level)) if level >= 0 => level,
            Ok(Some(_)) | Err(_) => return Err("invalid legacy provider backoff"),
        };
        let cooldown_until = pending_cooldown_ms(text("rate_limited_until")?.as_deref(), unix_now_ms()?);
        match row.try_get::<Option<i64>, _>("global_priority") {
            Ok(value) => legacy_global_priority(value)?,
            Err(sqlx::Error::ColumnNotFound(_)) => {}
            Err(_) => return Err("invalid legacy provider global priority"),
        }
        match row.try_get::<Option<i64>, _>("health_check_interval") {
            Ok(None | Some(0)) | Err(sqlx::Error::ColumnNotFound(_)) => {},
            Ok(_) => return Err("legacy provider selection or health policy requires migration"),
            Err(_) => return Err("invalid legacy provider policy"),
        }
        let rate_limit_protection = match row.try_get::<Option<i64>, _>("rate_limit_protection") {
            Ok(None | Some(0)) | Err(sqlx::Error::ColumnNotFound(_)) => false,
            // The legacy row mapping reads any other value as enabled.
            Ok(Some(_)) => true,
            Err(_) => return Err("invalid legacy provider policy"),
        };
        let queue_policy = legacy_queue_policy(rate_limit_protection, rate_limit_overrides.as_deref())?;
        let terminal = terminal_status_code(text("test_status")?.as_deref())?;
        let tenant = text("tenant_id")?.ok_or("legacy provider tenant is missing")?;
        let tenant_exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_tenants WHERE id=? AND enabled=1").bind(&tenant).fetch_one(&mut *target).await.map_err(|_| "destination tenant schema unavailable")?;
        if tenant_exists != 1 { return Err("legacy provider tenant is unavailable"); }
        let node = if crate::product_provider::chat_url(&provider).is_some() {
            None
        } else {
            Some(compatible_node(&mut target, &provider, &tenant).await?)
        };
        let (native_provider, upstream, protocol, node_id) = match node {
            Some(node) => (
                node.prefix,
                node.upstream_url,
                Some(node.protocol),
                Some(node.id),
            ),
            None => (
                provider.clone(),
                crate::product_provider::chat_url(&provider)
                    .ok_or("legacy provider transport is unsupported")?
                    .to_owned(),
                None,
                None,
            ),
        };
        let label = text("display_name")?.filter(|value| !value.trim().is_empty()).or(text("name")?.filter(|value| !value.trim().is_empty())).unwrap_or_else(|| id.to_owned());
        let label = label.trim();
        let email = text("email")?.unwrap_or_default();
        let email = email.trim();
        if crate::control_plane::validate_provider_label(label).is_err() || email.len() > 320 || email.chars().any(char::is_control) { return Err("invalid legacy provider identity"); }
        for table in ["redrouter_control_providers", "redrouter_control_provider_ownership", "redrouter_control_provider_auth", "redrouter_control_provider_oauth", "redrouter_control_provider_sessions", "redrouter_control_provider_protocols", "redrouter_control_provider_priorities", "redrouter_control_provider_defaults", "redrouter_control_provider_node_bindings", "redrouter_provider_model_rules"] {
            let column = if table == "redrouter_control_providers" { "id" } else { "provider_id" };
            let existing: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM \"{table}\" WHERE \"{column}\"=?")).bind(id).fetch_one(&mut *target).await.map_err(|_| "destination provider schema unavailable")?;
            if existing != 0 { return Err("destination provider already exists"); }
        }
        let stored = Zeroizing::new(text("api_key")?.ok_or("legacy provider credential is missing")?);
        let credential = crate::product::decrypt(&stored, Some(storage_key))?;
        if credential.is_empty() || credential.len() > 8192 { return Err("invalid legacy provider credential"); }
        let encrypted = crate::control_plane::encrypt(&credential, id, storage_key)?;
        sqlx::query("CREATE TABLE IF NOT EXISTS redrouter_legacy_provider_migration (provider_id TEXT PRIMARY KEY,source_enabled BIGINT NOT NULL)").execute(&mut *target).await.map_err(|_| "cannot initialize provider migration state")?;
        sqlx::query("INSERT INTO redrouter_legacy_provider_migration (provider_id,source_enabled) VALUES (?,?)").bind(id).bind(i64::from(source_enabled)).execute(&mut *target).await.map_err(|_| "provider migration state already exists")?;
        sqlx::query("INSERT INTO redrouter_control_providers (id,provider,upstream_url,credential_ciphertext,enabled,revision) VALUES (?,?,?,?,0,1)")
            .bind(id).bind(&native_provider).bind(&upstream).bind(&encrypted).execute(&mut *target).await.map_err(|_| "cannot write destination provider")?;
        record_imported_availability(&mut target, id, terminal, cooldown_until, backoff_level).await?;
        record_imported_concurrency(&mut target, id, max_concurrent).await?;
        record_imported_queue_policy(&mut target, id, queue_policy).await?;
        if priority != 0 {
            sqlx::query("INSERT INTO redrouter_control_provider_priorities (record_id,provider_id,account_rank,revision) VALUES (?,?,?,1)").bind(format!("{id}:1")).bind(id).bind(priority).execute(&mut *target).await.map_err(|_| "cannot write provider priority")?;
        }
        if let Some(model) = default_model {
            sqlx::query("INSERT INTO redrouter_control_provider_defaults (record_id,provider_id,model_name,revision) VALUES (?,?,?,1)").bind(format!("{id}:1")).bind(id).bind(model).execute(&mut *target).await.map_err(|_| "cannot write provider default model")?;
        }
        sqlx::query("INSERT INTO redrouter_control_provider_ownership (provider_id,tenant_id,revision) VALUES (?,?,1)")
            .bind(id).bind(&tenant).execute(&mut *target).await.map_err(|_| "cannot write provider ownership")?;
        if !model_rules.is_empty() {
            let json = serde_json::to_string(&model_rules).map_err(|_| "invalid legacy model exclusions")?;
            sqlx::query("INSERT INTO redrouter_provider_model_rules(provider_id,tenant_id,patterns_json,revision) VALUES (?,?,?,1)")
                .bind(id).bind(&tenant).bind(json).execute(&mut *target).await.map_err(|_| "cannot preserve legacy model exclusions")?;
        }
        sqlx::query("INSERT INTO redrouter_control_provider_auth (record_id,provider_id,auth_scheme,label,account_email,expires_at_unix,revision) VALUES (?,?,'auto',?,?,0,1)")
            .bind(format!("{id}:1")).bind(id).bind(label).bind(email).execute(&mut *target).await.map_err(|_| "cannot write provider identity")?;
        if let Some(protocol) = protocol {
            sqlx::query("INSERT INTO redrouter_control_provider_protocols (record_id,provider_id,protocol,revision) VALUES (?,?,?,1)")
                .bind(format!("{id}:1")).bind(id).bind(protocol).execute(&mut *target).await.map_err(|_| "cannot write provider protocol")?;
        }
        if let Some(node_id) = node_id {
            sqlx::query("INSERT INTO redrouter_control_provider_node_bindings (record_id,provider_id,node_id,revision) VALUES (?,?,?,1)")
                .bind(format!("{id}:1")).bind(id).bind(node_id).execute(&mut *target).await.map_err(|_| "cannot bind provider definition")?;
        }
        Ok(ProviderImport { imported: 1, enabled: false, source_enabled })
    }.await;
    match result {
        Ok(report) => {
            snapshot
                .commit()
                .await
                .map_err(|_| "cannot finish legacy snapshot")?;
            target
                .commit()
                .await
                .map_err(|_| "cannot commit provider import")?;
            Ok(report)
        }
        Err(error) => {
            let _ = target.rollback().await;
            let _ = snapshot.rollback().await;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_rate_limit_overrides_become_the_queue_policy() {
        assert_eq!(legacy_queue_policy(false, None), Ok(None));
        assert_eq!(legacy_queue_policy(false, Some("{}")), Ok(None));
        // Non-positive overrides fall through, as legacy resolveOverride does.
        assert_eq!(legacy_queue_policy(false, Some(r#"{"rpm":0}"#)), Ok(None));
        assert_eq!(
            legacy_queue_policy(
                true,
                Some(r#"{"rpm":30,"minTime":250.7,"maxConcurrent":2,"maxWaitMs":9000,"tpm":1}"#)
            ),
            Ok(Some(crate::request_queue::ConnectionQueuePolicy {
                protection: true,
                requests_per_minute: Some(30),
                min_time_between_requests_ms: Some(250),
                concurrent_requests: Some(2),
                max_wait_ms: Some(9_000),
            }))
        );
        assert_eq!(
            legacy_queue_policy(false, Some(r#"{"executionMaxWaitMs":5}"#)),
            Ok(None)
        );
        assert!(legacy_queue_policy(false, Some("[1]")).is_err());
    }

    #[test]
    fn legacy_global_priority_is_validated_and_dropped() {
        for value in [None, Some(0), Some(1), Some(100_000)] {
            assert_eq!(legacy_global_priority(value), Ok(()));
        }
        for value in [Some(-1), Some(100_001)] {
            assert_eq!(
                legacy_global_priority(value),
                Err("invalid legacy provider global priority")
            );
        }
    }

    #[test]
    fn only_future_legacy_cooldowns_carry_over() {
        let now = 1_800_000_000_000;
        assert_eq!(
            pending_cooldown_ms(Some(" 2099-01-01T00:00:00.000Z "), now),
            Some(4_070_908_800_000)
        );
        assert_eq!(pending_cooldown_ms(Some("2020-01-01T00:00:00Z"), now), None);
        assert_eq!(pending_cooldown_ms(Some("not a date"), now), None);
        assert_eq!(pending_cooldown_ms(None, now), None);
    }

    #[test]
    fn legacy_health_states_map_to_native_terminal_statuses() {
        assert_eq!(terminal_status_code(Some("expired")), Ok(Some(401)));
        assert_eq!(
            terminal_status_code(Some("credits_exhausted")),
            Ok(Some(402))
        );
        assert_eq!(terminal_status_code(Some("deactivated")), Ok(Some(403)));
        assert_eq!(terminal_status_code(Some("degraded")), Ok(None));
        assert_eq!(terminal_status_code(None), Ok(None));
        assert!(terminal_status_code(Some("mystery")).is_err());
    }

    #[tokio::test]
    async fn a_terminal_state_wins_over_a_pending_cooldown() {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        let future = 9_999_999_999_999;
        record_imported_availability(&mut db, "a", None, Some(future), 40)
            .await
            .unwrap();
        record_imported_availability(&mut db, "b", Some(403), Some(future), 2)
            .await
            .unwrap();
        record_imported_availability(&mut db, "c", None, None, 3)
            .await
            .unwrap();
        let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as("SELECT provider_id,cooldown_until_unix_ms,backoff_level,last_status FROM redrouter_provider_availability ORDER BY provider_id")
            .fetch_all(&mut db)
            .await
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("a".to_owned(), future, 16, 429),
                ("b".to_owned(), i64::MAX, 1, 403),
            ]
        );
    }
}
