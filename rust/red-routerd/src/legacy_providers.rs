//! Offline staging and adoption of legacy provider accounts. Unsupported
//! routing metadata is intentionally refused rather than silently discarded.
use crate::storage::StoredProviderNode;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::path::Path;
use zeroize::Zeroizing;

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
        for field in ["per_key_proxy_enabled", "proxy_enabled", "max_concurrent", "global_priority", "backoff_level", "rate_limit_protection"] {
            match object.get(field) { Some(serde_json::Value::Null) => {}, Some(value) if value.as_i64() == Some(0) => {}, _ => return Err("legacy provider policy requires migration") }
        }
        for field in ["quota_window_thresholds_json", "rate_limit_overrides_json"] {
            if text(field)?.is_some_and(|value| !matches!(value.trim(), "" | "null" | "{}" | "[]")) { return Err("legacy provider policy requires migration"); }
        }
        let default_model = text("default_model")?.filter(|value| !value.is_empty());
        if default_model.is_some_and(|value| !crate::control_plane::model_aliases::valid_model_name(value)) { return Err("invalid legacy provider default model"); }
        for field in ["rate_limited_until", "group", "api_key", "error_code", "last_error", "last_error_type", "last_error_source"] {
            if text(field)?.is_some_and(|value| !value.trim().is_empty()) { return Err("legacy provider configuration requires migration"); }
        }
        if text("test_status")?.is_some_and(|status| !matches!(status, "" | "untested" | "success" | "active")) { return Err("legacy provider health requires migration"); }
        let tenant = text("tenant_id")?.ok_or("legacy provider tenant is missing")?;
        let tenant_exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_tenants WHERE id=? AND enabled=1").bind(tenant).fetch_one(&mut db).await.map_err(|_| "destination tenant unavailable")?;
        if tenant_exists != 1 { return Err("legacy provider tenant is unavailable"); }
        for table in ["redrouter_control_providers", "redrouter_control_provider_ownership", "redrouter_control_provider_auth", "redrouter_control_provider_oauth", "redrouter_control_provider_sessions", "redrouter_control_provider_priorities", "redrouter_control_provider_defaults", "redrouter_control_provider_oauth_status", "redrouter_provider_resilience", "redrouter_provider_quotas", "redrouter_provider_model_quotas", "redrouter_provider_breakers", "redrouter_provider_breaker_overrides", "redrouter_provider_availability"] {
            let column = if table == "redrouter_control_providers" { "id" } else { "provider_id" };
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM \"{table}\" WHERE \"{column}\"=?")).bind(id).fetch_one(&mut db).await.map_err(|_| "destination provider schema unavailable")?;
            if count != 0 { return Err("destination provider already exists"); }
        }
        let token = |name| -> Result<Zeroizing<String>, &'static str> {
            let stored = text(name)?.filter(|value| !value.is_empty()).ok_or("legacy OAuth token is missing")?;
            crate::product::decrypt(stored, Some(legacy_key))
        };
        let access = token("access_token")?;
        let refresh = token("refresh_token")?;
        let specific: serde_json::Value = match text("provider_specific_data")? {
            None | Some("") => serde_json::json!({}),
            Some(value) => serde_json::from_str(value).map_err(|_| "invalid legacy OAuth metadata")?,
        };
        let specific = specific.as_object().ok_or("invalid legacy OAuth metadata")?;
        let (access, refresh, session, parsed_expiry, parsed_email, upstream) = if provider == "codex" {
            let id_token = token("id_token")?;
            let parsed = crate::control_plane::parse_codex_auth(serde_json::json!({"auth_mode":"chatgpt", "tokens": {"access_token":access.as_str(),"refresh_token":refresh.as_str(),"id_token":id_token.as_str()}}))?;
            if specific.keys().any(|key| !matches!(key.as_str(), "workspaceId" | "workspacePlanType" | "chatgptUserId" | "organizations" | "autoSync")) { return Err("legacy Codex configuration requires migration"); }
            if let Some(workspace) = specific.get("workspaceId").filter(|value| !value.is_null()) {
                if workspace.as_str() != Some(parsed.account_id.as_str()) { return Err("legacy Codex workspace requires reconciliation"); }
            }
            (parsed.access_token, parsed.refresh_token, parsed.session_metadata, parsed.expires_at_unix, parsed.email, crate::control_plane::CODEX_PROVIDER_URL)
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
            let session = Zeroizing::new(metadata.to_string());
            let email = specific.get("bootstrapEmail").and_then(serde_json::Value::as_str).filter(|value| !value.trim().is_empty()).map(str::to_owned);
            (parsed.access_token, parsed.refresh_token, session, parsed.expires_at_unix, email, crate::control_plane::CLAUDE_PROVIDER_URL)
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
        if priority != 0 {
            sqlx::query("INSERT INTO redrouter_control_provider_priorities (record_id,provider_id,account_rank,revision) VALUES (?,?,?,1)").bind(format!("{id}:1")).bind(id).bind(priority).execute(&mut db).await.map_err(|_| "cannot write provider priority")?;
        }
        if let Some(model) = default_model {
            sqlx::query("INSERT INTO redrouter_control_provider_defaults (record_id,provider_id,model_name,revision) VALUES (?,?,?,1)").bind(format!("{id}:1")).bind(id).bind(model).execute(&mut db).await.map_err(|_| "cannot write provider default model")?;
        }
        sqlx::query("INSERT INTO redrouter_control_provider_ownership VALUES (?,?,1)").bind(id).bind(tenant).execute(&mut db).await.map_err(|_| "cannot write provider ownership")?;
        sqlx::query("INSERT INTO redrouter_control_provider_auth VALUES (?,?,'bearer',?,?,?,1)").bind(format!("{id}:1")).bind(id).bind(label).bind(email).bind(expires).execute(&mut db).await.map_err(|_| "cannot write provider identity")?;
        sqlx::query("INSERT INTO redrouter_control_provider_oauth VALUES (?,?,?,0,1)").bind(id).bind(provider).bind(refresh_cipher).execute(&mut db).await.map_err(|_| "cannot write OAuth refresh token")?;
        sqlx::query("INSERT INTO redrouter_control_provider_sessions VALUES (?,?,?,1)").bind(id).bind(provider).bind(session_cipher).execute(&mut db).await.map_err(|_| "cannot write OAuth session")?;
        sqlx::query("INSERT INTO redrouter_provider_resilience VALUES (?,?,'connection',1)").bind(format!("{id}:1")).bind(id).execute(&mut db).await.map_err(|_| "cannot write provider resilience")?;
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
        for field in ["access_token", "refresh_token", "id_token", "expires_at", "token_expires_at", "scope", "project_id", "rate_limited_until", "group"] {
            if text(field)?.is_some_and(|value| !value.trim().is_empty()) { return Err("legacy provider metadata requires migration"); }
        }
        let default_model = text("default_model")?.filter(|value| !value.is_empty());
        if default_model.as_deref().is_some_and(|value| !crate::control_plane::model_aliases::valid_model_name(value)) { return Err("invalid legacy provider default model"); }
        for field in ["provider_specific_data", "quota_window_thresholds_json", "rate_limit_overrides_json"] {
            if text(field)?.is_some_and(|value| !matches!(value.trim(), "" | "null" | "{}" | "[]")) { return Err("legacy provider configuration requires migration"); }
        }
        for field in ["per_key_proxy_enabled", "proxy_enabled", "max_concurrent"] {
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
        for field in ["global_priority", "backoff_level", "rate_limit_protection", "health_check_interval"] {
            match row.try_get::<Option<i64>, _>(field) {
                Ok(None | Some(0)) | Err(sqlx::Error::ColumnNotFound(_)) => {},
                Ok(_) => return Err("legacy provider selection or health policy requires migration"),
                Err(_) => return Err("invalid legacy provider policy"),
            }
        }
        if text("test_status")?.is_some_and(|status| !matches!(status.as_str(), "" | "untested" | "success" | "active")) {
            return Err("legacy provider health requires migration");
        }
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
        for table in ["redrouter_control_providers", "redrouter_control_provider_ownership", "redrouter_control_provider_auth", "redrouter_control_provider_oauth", "redrouter_control_provider_sessions", "redrouter_control_provider_protocols", "redrouter_control_provider_priorities", "redrouter_control_provider_defaults", "redrouter_control_provider_node_bindings"] {
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
        if priority != 0 {
            sqlx::query("INSERT INTO redrouter_control_provider_priorities (record_id,provider_id,account_rank,revision) VALUES (?,?,?,1)").bind(format!("{id}:1")).bind(id).bind(priority).execute(&mut *target).await.map_err(|_| "cannot write provider priority")?;
        }
        if let Some(model) = default_model {
            sqlx::query("INSERT INTO redrouter_control_provider_defaults (record_id,provider_id,model_name,revision) VALUES (?,?,?,1)").bind(format!("{id}:1")).bind(id).bind(model).execute(&mut *target).await.map_err(|_| "cannot write provider default model")?;
        }
        sqlx::query("INSERT INTO redrouter_control_provider_ownership (provider_id,tenant_id,revision) VALUES (?,?,1)")
            .bind(id).bind(&tenant).execute(&mut *target).await.map_err(|_| "cannot write provider ownership")?;
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
