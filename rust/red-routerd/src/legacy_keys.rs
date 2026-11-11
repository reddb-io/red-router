//! Deliberately narrow offline import of unrestricted legacy client keys.
//! Any policy we cannot faithfully translate makes the whole import fail.
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{collections::HashSet, path::Path};
use zeroize::Zeroizing;

const COLUMNS: &[&str] = &[
    "id",
    "name",
    "key",
    "machine_id",
    "created_at",
    "allowed_models",
    "model_access_mode",
    "blocked_models",
    "allowed_combos",
    "no_log",
    "allowed_connections",
    "auto_resolve",
    "is_active",
    "access_schedule",
    "max_requests_per_day",
    "max_requests_per_minute",
    "throttle_delay_ms",
    "max_sessions",
    "revoked_at",
    "expires_at",
    "last_used_at",
    "key_prefix",
    "ip_allowlist",
    "scopes",
    "rate_limits",
    "is_banned",
    "key_hash",
    "proxy_id",
    "allowed_endpoints",
    "allowed_quotas",
    "stream_default_mode",
    "cache_default_mode",
    "disable_non_public_models",
    "allow_usage_command",
    "usage_limit_enabled",
    "daily_usage_limit_usd",
    "weekly_usage_limit_usd",
    "chaos_mode_enabled",
    "compression_enabled",
    "allow_auto_combos",
    "catalog_scope",
    "tenant_id",
];

// Even disabled or unmatched rows are rejected: deleting a policy or changing
// a key later must not silently activate an incomplete migration.
const POLICY_TABLES: &[&str] = &[
    "api_key_quota_limits",
    "api_key_token_limits",
    "api_key_daily_token_limits",
    "domain_budgets",
    "budget_assignments",
    "key_group_members",
    "api_key_context_sources",
    "api_key_usage_reservations",
    "model_combo_mappings",
];

#[derive(Debug, serde::Serialize)]
pub struct KeyImport {
    pub imported: u64,
    pub disabled: u64,
}

/// Source and destination must be offline for cutover. Only current-schema keys
/// without restrictions or quotas are supported; this does not migrate history.
pub async fn import(source: &Path, destination: &Path) -> Result<KeyImport, &'static str> {
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
    .map_err(|_| "cannot open legacy SQLite database read-only")?;
    sqlx::query("PRAGMA query_only = ON")
        .execute(&mut input)
        .await
        .map_err(|_| "cannot initialize legacy database")?;
    let mut output =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(destination))
            .await
            .map_err(|_| "cannot open destination SQLite database")?;
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
        .map_err(|_| "cannot start key import")?;
    let result: Result<KeyImport, &'static str> = async {
        // A separate Rust database must not contain the legacy table. This also
        // prevents a hard link to the source from bypassing the path check.
        let legacy_in_destination: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='api_keys'")
            .fetch_one(&mut *target).await.map_err(|_| "cannot inspect destination schema")?;
        if legacy_in_destination != 0 { return Err("destination contains legacy tables; use a separate Rust database"); }
        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('api_keys')")
            .fetch_all(&mut *snapshot).await.map_err(|_| "cannot inspect legacy key schema")?;
        if columns.len() != COLUMNS.len() || COLUMNS.iter().any(|column| !columns.iter().any(|found| found == column)) {
            return Err("unsupported legacy key schema; no keys imported");
        }
        for table in POLICY_TABLES {
            let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?")
                .bind(table).fetch_one(&mut *snapshot).await.map_err(|_| "cannot inspect legacy policy schema")?;
            if exists != 1 { return Err("legacy policy schema incomplete; no keys imported"); }
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM \"{table}\""))
                .fetch_one(&mut *snapshot).await.map_err(|_| "cannot inspect legacy policies")?;
            if count != 0 { return Err("legacy policy, quota or reservation requires migration; no keys imported"); }
        }
        let settings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM key_value WHERE (namespace='settings' AND key='disabledModels' AND trim(value) NOT IN ('[]','null')) OR (namespace='api_key_tags')")
            .fetch_one(&mut *snapshot).await.map_err(|_| "cannot inspect legacy settings")?;
        if settings != 0 { return Err("legacy model policy or key tags require migration; no keys imported"); }
        for table in ["redrouter_control_client_keys", "redrouter_control_client_key_preferences", "redrouter_control_client_key_schedules", "redrouter_control_client_key_ownership", "redrouter_control_client_key_quotas"] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM \"{table}\""))
                .fetch_one(&mut *target).await.map_err(|_| "destination key schema unavailable")?;
            if count != 0 { return Err("destination key tables must be empty; no keys imported"); }
        }
        let rows = sqlx::query("SELECT k.*, unixepoch(k.expires_at) AS __expiry, (SELECT value FROM key_value WHERE namespace='api_key_id_format' AND key=k.id) AS __format, (SELECT value FROM key_value WHERE namespace='api_key_usage_attributes' AND key=k.id) AS __attributes FROM api_keys k ORDER BY k.id LIMIT 10001")
            .fetch_all(&mut *snapshot).await.map_err(|_| "cannot read legacy keys")?;
        if rows.len() > 10_000 { return Err("too many legacy keys; no keys imported"); }
        let mut hashes = HashSet::new();
        let mut disabled = 0u64;
        for row in &rows {
            let get = |name: &str| row.try_get::<Option<String>, _>(name).map_err(|_| "invalid legacy key");
            let number = |name: &str| row.try_get::<Option<i64>, _>(name).map_err(|_| "invalid legacy key");
            let id = get("id")?.ok_or("invalid legacy key")?;
            let label = get("name")?.ok_or("invalid legacy key")?;
            let tenant = get("tenant_id")?.ok_or("invalid legacy key")?;
            if !valid_id(&id) || !valid_id(&tenant) || label.trim().is_empty() || label.len() > 128 || label.chars().any(char::is_control) {
                return Err("invalid legacy key identity; no keys imported");
            }
            let tenant_enabled: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_tenants WHERE id=? AND enabled=1")
                .bind(&tenant).fetch_one(&mut *target).await.map_err(|_| "destination tenant schema unavailable")?;
            if tenant_enabled != 1 { return Err("legacy key tenant is unavailable; no keys imported"); }
            for field in ["no_log", "auto_resolve", "max_requests_per_day", "max_requests_per_minute", "throttle_delay_ms", "max_sessions", "disable_non_public_models", "allow_usage_command", "usage_limit_enabled", "chaos_mode_enabled"] {
                if number(field)?.unwrap_or(0) != 0 { return Err("legacy key policy is unsupported; no keys imported"); }
            }
            for field in ["daily_usage_limit_usd", "weekly_usage_limit_usd"] {
                if row.try_get::<Option<f64>, _>(field).map_err(|_| "invalid legacy key")?.is_some() {
                    return Err("legacy spending limits require migration; no keys imported");
                }
            }
            if number("compression_enabled")? != Some(1) || number("allow_auto_combos")? != Some(1) {
                return Err("legacy key behavior is unsupported; no keys imported");
            }
            for field in ["allowed_models", "blocked_models", "allowed_connections", "ip_allowlist", "scopes", "rate_limits", "allowed_endpoints", "allowed_quotas"] {
                if !empty_list(get(field)?.as_deref())? { return Err("legacy key policy is unsupported; no keys imported"); }
            }
            if !matches!(get("model_access_mode")?.as_deref(), Some("all")) || !matches!(get("catalog_scope")?.as_deref(), Some("all")) || !matches!(get("stream_default_mode")?.as_deref(), Some("legacy")) || !matches!(get("cache_default_mode")?.as_deref(), Some("legacy")) {
                return Err("legacy key behavior is unsupported; no keys imported");
            }
            let combos = get("allowed_combos")?;
            if combos.as_deref().is_some_and(|raw| serde_json::from_str::<Vec<String>>(raw).ok().as_deref() != Some(&["combo/*".to_owned()][..])) {
                return Err("legacy combo policy is unsupported; no keys imported");
            }
            for field in ["access_schedule", "proxy_id"] {
                if get(field)?.is_some_and(|value| !value.trim().is_empty()) { return Err("legacy key policy is unsupported; no keys imported"); }
            }
            if get("__attributes")?.is_some_and(|value| serde_json::from_str::<serde_json::Value>(&value).ok() != Some(serde_json::json!({}))) {
                return Err("legacy usage attributes require migration; no keys imported");
            }
            let format = get("__format")?.unwrap_or_else(|| "prefixed".to_owned());
            if !matches!(format.as_str(), "prefixed" | "flat") { return Err("invalid legacy key format"); }
            let active = number("is_active")?;
            let banned = number("is_banned")?;
            if !matches!(active, Some(0 | 1)) || !matches!(banned, Some(0 | 1)) { return Err("invalid legacy key status"); }
            let enabled = active == Some(1) && banned == Some(0) && get("revoked_at")?.is_none();
            if !enabled { disabled += 1; }
            let expiry = match get("expires_at")? {
                None => 0,
                Some(value) if value.trim().is_empty() => 0,
                Some(_) => row.try_get::<Option<i64>, _>("__expiry").map_err(|_| "invalid legacy expiry")?.filter(|value| *value > 0).ok_or("invalid legacy expiry")?,
            };
            let key = Zeroizing::new(get("key")?.ok_or("invalid legacy key")?);
            if !(16..=512).contains(&key.len()) { return Err("invalid legacy key credential"); }
            let hash = hex::encode(Sha256::digest(key.as_bytes()));
            if get("key_hash")?.is_some_and(|existing| !existing.is_empty() && existing != hash) || !hashes.insert(hash.clone()) {
                return Err("legacy key digest mismatch or duplicate; no keys imported");
            }
            sqlx::query("INSERT INTO redrouter_control_client_keys (id,label,key_hash,enabled,expiry_unix,scopes_json,allowed_endpoints_json,allowed_models_json,blocked_models_json,allowed_provider_ids_json,max_concurrent,max_rpm,max_rpd,revision) VALUES (?,?,?,?,?,'[]','[]','[]','[]','[]',0,0,0,1)")
                .bind(&id).bind(&label).bind(&hash).bind(i64::from(enabled)).bind(expiry).execute(&mut *target).await.map_err(|_| "cannot write destination key")?;
            sqlx::query("INSERT INTO redrouter_control_client_key_preferences (key_id,model_id_format,revision) VALUES (?,?,1)").bind(&id).bind(format).execute(&mut *target).await.map_err(|_| "cannot write key format")?;
            sqlx::query("INSERT INTO redrouter_control_client_key_schedules (key_id,schedule_json,revision) VALUES (?,'',1)").bind(&id).execute(&mut *target).await.map_err(|_| "cannot write key schedule")?;
            sqlx::query("INSERT INTO redrouter_control_client_key_ownership (key_id,tenant_id,created_by,revision) VALUES (?,?,'legacy-migration',1)").bind(&id).bind(&tenant).execute(&mut *target).await.map_err(|_| "cannot write key ownership")?;
            sqlx::query("INSERT INTO redrouter_control_client_key_quotas (key_id,max_tokens_per_minute,max_tokens_per_day,max_monthly_microusd,reservation_tokens,reservation_microusd,revision) VALUES (?,0,0,0,0,0,1)").bind(&id).execute(&mut *target).await.map_err(|_| "cannot write key quota")?;
        }
        Ok(KeyImport { imported: rows.len() as u64, disabled })
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
                .map_err(|_| "cannot commit key import")?;
            Ok(report)
        }
        Err(error) => {
            let _ = target.rollback().await;
            let _ = snapshot.rollback().await;
            Err(error)
        }
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
fn empty_list(value: Option<&str>) -> Result<bool, &'static str> {
    match value {
        None | Some("") => Ok(true),
        Some(raw) => serde_json::from_str::<Vec<String>>(raw)
            .map(|list| list.is_empty())
            .map_err(|_| "invalid legacy key policy"),
    }
}
