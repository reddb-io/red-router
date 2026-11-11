//! Offline staging of one simple legacy API-key provider. OAuth and routing
//! metadata require separate migration and are intentionally refused.
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::path::Path;
use zeroize::Zeroizing;

#[derive(serde::Serialize)]
pub struct ProviderImport {
    pub imported: u64,
    pub enabled: bool,
    pub source_enabled: bool,
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
        let row = sqlx::query("SELECT provider,auth_type,name,display_name,email,is_active,api_key,tenant_id,access_token,refresh_token,id_token,expires_at,token_expires_at,scope,project_id,provider_specific_data,rate_limited_until,per_key_proxy_enabled,proxy_enabled,max_concurrent,quota_window_thresholds_json,rate_limit_overrides_json,default_model,\"group\",test_status FROM provider_connections WHERE id=?")
            .bind(id).fetch_optional(&mut *snapshot).await.map_err(|_| "unsupported legacy provider schema")?.ok_or("legacy provider not found")?;
        let text = |field: &str| row.try_get::<Option<String>, _>(field).map_err(|_| "invalid legacy provider");
        let number = |field: &str| row.try_get::<Option<i64>, _>(field).map_err(|_| "invalid legacy provider");
        let provider = text("provider")?.ok_or("invalid legacy provider")?;
        let upstream = crate::product_provider::chat_url(&provider).ok_or("legacy provider transport is unsupported")?;
        if text("auth_type")?.as_deref() != Some("apikey") { return Err("legacy OAuth or provider authentication requires migration"); }
        let source_enabled = match number("is_active")? { Some(0) => false, Some(1) => true, _ => return Err("invalid legacy provider status") };
        for field in ["access_token", "refresh_token", "id_token", "expires_at", "token_expires_at", "scope", "project_id", "rate_limited_until", "default_model", "group"] {
            if text(field)?.is_some_and(|value| !value.trim().is_empty()) { return Err("legacy provider metadata requires migration"); }
        }
        for field in ["provider_specific_data", "quota_window_thresholds_json", "rate_limit_overrides_json"] {
            if text(field)?.is_some_and(|value| !matches!(value.trim(), "" | "null" | "{}" | "[]")) { return Err("legacy provider configuration requires migration"); }
        }
        for field in ["per_key_proxy_enabled", "proxy_enabled", "max_concurrent"] {
            if number(field)?.unwrap_or(0) != 0 { return Err("legacy provider policy requires migration"); }
        }
        if text("test_status")?.is_some_and(|status| !matches!(status.as_str(), "" | "untested" | "success" | "active")) {
            return Err("legacy provider health requires migration");
        }
        let tenant = text("tenant_id")?.ok_or("legacy provider tenant is missing")?;
        let tenant_exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_tenants WHERE id=? AND enabled=1").bind(&tenant).fetch_one(&mut *target).await.map_err(|_| "destination tenant schema unavailable")?;
        if tenant_exists != 1 { return Err("legacy provider tenant is unavailable"); }
        let label = text("display_name")?.filter(|value| !value.trim().is_empty()).or(text("name")?.filter(|value| !value.trim().is_empty())).unwrap_or_else(|| id.to_owned());
        let label = label.trim();
        let email = text("email")?.unwrap_or_default();
        let email = email.trim();
        if label.is_empty() || label.len() > 128 || label.chars().any(char::is_control) || email.len() > 320 || email.chars().any(char::is_control) { return Err("invalid legacy provider identity"); }
        for table in ["redrouter_control_providers", "redrouter_control_provider_ownership", "redrouter_control_provider_auth", "redrouter_control_provider_oauth", "redrouter_control_provider_sessions"] {
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
            .bind(id).bind(&provider).bind(upstream).bind(&encrypted).execute(&mut *target).await.map_err(|_| "cannot write destination provider")?;
        sqlx::query("INSERT INTO redrouter_control_provider_ownership (provider_id,tenant_id,revision) VALUES (?,?,1)")
            .bind(id).bind(&tenant).execute(&mut *target).await.map_err(|_| "cannot write provider ownership")?;
        sqlx::query("INSERT INTO redrouter_control_provider_auth (record_id,provider_id,auth_scheme,label,account_email,expires_at_unix,revision) VALUES (?,?,'auto',?,?,0,1)")
            .bind(format!("{id}:1")).bind(id).bind(label).bind(email).execute(&mut *target).await.map_err(|_| "cannot write provider identity")?;
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
