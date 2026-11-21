//! Offline import of legacy client keys and supported access schedules.
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
    "domain_budgets",
    "budget_assignments",
    "key_group_members",
    "api_key_context_sources",
    "model_combo_mappings",
];

const TOKEN_LIMIT_COLUMNS: &[&str] = &[
    "id",
    "api_key_id",
    "scope_type",
    "scope_value",
    "token_limit",
    "reset_interval",
    "reset_time",
    "enabled",
    "created_at",
    "updated_at",
];

#[derive(Debug, serde::Serialize)]
pub struct KeyImport {
    pub imported: u64,
    pub disabled: u64,
    pub source_enabled: u64,
}

/// Source and destination must be offline for cutover. Only current-schema keys
/// with supported schedules are accepted. Other restrictions still require a
/// faithful translation; quotas/history use the separate adoption pipeline.
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
        // Model token limits have a native adoption path. Refuse older or
        // unknown table shapes and provider/global scopes instead of silently
        // weakening their semantics. Imported keys still remain disabled until
        // `legacy-quota-adopt` copies limits and the active-window counters.
        let token_columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('api_key_token_limits')")
            .fetch_all(&mut *snapshot).await.map_err(|_| "cannot inspect legacy token limit schema")?;
        if token_columns.len() != TOKEN_LIMIT_COLUMNS.len()
            || TOKEN_LIMIT_COLUMNS.iter().any(|column| !token_columns.iter().any(|found| found == column))
        {
            return Err("unsupported legacy token limit schema; no keys imported");
        }
        let unsupported_token_limits: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM api_key_token_limits WHERE scope_type <> 'model' OR enabled NOT IN (0,1) OR reset_interval NOT IN ('daily','weekly','monthly')")
            .fetch_one(&mut *snapshot).await.map_err(|_| "cannot inspect legacy token limits")?;
        if unsupported_token_limits != 0 {
            return Err("provider or global token limits require migration; no keys imported");
        }
        let settings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM key_value WHERE (namespace='settings' AND ((key IN ('disabledModels','modelVisibilityAllowlist','modelVisibilityDenylist') AND COALESCE(trim(value),'') NOT IN ('[]','null')) OR (key IN ('hidePaidModels','excludeTosAvoid','hideAutoCombos') AND COALESCE(trim(value),'') NOT IN ('false','null')) OR (key='freeAccessPolicy' AND COALESCE(trim(value),'') NOT IN ('\"off\"','null')) OR (key='proxyEnabled' AND COALESCE(trim(value),'') <> 'true'))) OR (namespace='api_key_tags')")
            .fetch_one(&mut *snapshot).await.map_err(|_| "cannot inspect legacy settings")?;
        if settings != 0 { return Err("legacy model policy or key tags require migration; no keys imported"); }
        let prefer_claude: Option<String> = sqlx::query_scalar("SELECT value FROM key_value WHERE namespace='settings' AND key='preferClaudeCodeForUnprefixedClaudeModels'")
            .fetch_optional(&mut *snapshot).await.map_err(|_| "cannot inspect legacy Claude routing setting")?;
        let prefer_claude_code = match prefer_claude.as_deref() {
            Some("true") => true,
            Some("false") => false,
            None | Some("null") => std::env::var("OMNIROUTE_PREFER_CLAUDE_CODE_FOR_UNPREFIXED_CLAUDE_MODELS")
                .is_ok_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")),
            _ => return Err("invalid legacy Claude routing setting; no keys imported"),
        };
        for table in ["redrouter_control_client_keys", "redrouter_control_client_key_preferences", "redrouter_control_client_key_schedules", "redrouter_control_client_key_model_access", "redrouter_control_client_key_combo_access", "redrouter_control_client_key_catalog", "redrouter_control_client_key_limits", "redrouter_control_client_key_ownership", "redrouter_control_client_key_quotas"] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM \"{table}\""))
                .fetch_one(&mut *target).await.map_err(|_| "destination key schema unavailable")?;
            if count != 0 { return Err("destination key tables must be empty; no keys imported"); }
        }
        let rows = sqlx::query("SELECT k.*, unixepoch(k.expires_at) AS __expiry, (SELECT value FROM key_value WHERE namespace='api_key_id_format' AND key=k.id) AS __format, (SELECT value FROM key_value WHERE namespace='api_key_usage_attributes' AND key=k.id) AS __attributes FROM api_keys k ORDER BY k.id LIMIT 10001")
            .fetch_all(&mut *snapshot).await.map_err(|_| "cannot read legacy keys")?;
        if rows.len() > 10_000 { return Err("too many legacy keys; no keys imported"); }
        sqlx::query("CREATE TABLE IF NOT EXISTS redrouter_legacy_key_migration (key_id TEXT PRIMARY KEY, source_is_active BIGINT NOT NULL, source_is_banned BIGINT NOT NULL, source_revoked_at TEXT)")
            .execute(&mut *target).await.map_err(|_| "cannot initialize key migration state")?;
        let migration_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_legacy_key_migration")
            .fetch_one(&mut *target).await.map_err(|_| "cannot inspect key migration state")?;
        if migration_rows != 0 { return Err("destination key migration state must be empty; no keys imported"); }
        let mut hashes = HashSet::new();
        let mut source_enabled = 0u64;
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
            // no_log only kept request/response bodies out of the legacy call
            // and detail logs. The native gateway persists no payload for any
            // key, so the opt-out already holds; only a boolean is accepted.
            if !matches!(number("no_log")?, None | Some(0 | 1)) { return Err("invalid legacy key logging policy; no keys imported"); }
            // auto_resolve is stored and shown by the legacy dashboard, but no
            // legacy routing path reads the key's value; only a boolean imports.
            if !matches!(number("auto_resolve")?, None | Some(0 | 1)) { return Err("invalid legacy key resolution flag; no keys imported"); }
            // The active-session cap and throttle delay become the key's runtime
            // limits; the legacy throttle is applied up to five minutes.
            let limits = crate::client_key_limits::KeyRuntimeLimits {
                // Zero or negative means unlimited, as the legacy check does.
                max_sessions: match number("max_sessions")? {
                    None => 0,
                    Some(value) if value <= 0 => 0,
                    Some(value) => u32::try_from(value).ok().filter(|value| *value <= crate::client_key_limits::MAX_KEY_SESSIONS).ok_or("unsupported legacy session cap; no keys imported")?,
                },
                throttle_delay_ms: match number("throttle_delay_ms")? {
                    None => 0,
                    Some(value) => u64::try_from(value).unwrap_or(0).min(crate::client_key_limits::MAX_THROTTLE_DELAY_MS),
                },
            }
            .encode();
            for field in ["allow_usage_command", "usage_limit_enabled", "chaos_mode_enabled"] {
                if number(field)?.unwrap_or(0) != 0 { return Err("legacy key policy is unsupported; no keys imported"); }
            }
            // Legacy request limits (fixed 60-second and one-day windows, used
            // while the key has no custom rate rules) become the native per-key
            // limits, whose sliding windows never admit more requests.
            let request_limit = |name: &str, max: i64| -> Result<i64, &'static str> {
                match number(name)? {
                    None => Ok(0),
                    Some(value) if (0..=max).contains(&value) => Ok(value),
                    Some(_) => Err("unsupported legacy request limit; no keys imported"),
                }
            };
            let max_rpm = request_limit("max_requests_per_minute", 10_000)?;
            let max_rpd = request_limit("max_requests_per_day", 10_000_000)?;
            // Custom rate rules replace those columns (legacy buildRateLimitRules).
            let (max_rpm, max_rpd) = import_rate_rules(get("rate_limits")?.as_deref())?.unwrap_or((max_rpm, max_rpd));
            for field in ["daily_usage_limit_usd", "weekly_usage_limit_usd"] {
                if row.try_get::<Option<f64>, _>(field).map_err(|_| "invalid legacy key")?.is_some() {
                    return Err("legacy spending limits require migration; no keys imported");
                }
            }
            // compression_enabled=0 and cache_default_mode='bypass' opt a key
            // out of prompt compression and the semantic cache. The native
            // gateway has neither, so both opt-outs already hold for every key
            // (any such feature added later must honor a per-key opt-out).
            if !matches!(number("compression_enabled")?, Some(0 | 1)) {
                return Err("legacy key behavior is unsupported; no keys imported");
            }
            // The legacy router stores and returns ip_allowlist but never
            // enforces it (no request path reads it), so a valid list of
            // address strings imports without granting or removing access.
            if let Some(raw) = get("ip_allowlist")?.filter(|raw| !raw.trim().is_empty()) {
                let entries: Vec<String> = serde_json::from_str(&raw).map_err(|_| "invalid legacy key IP allowlist; no keys imported")?;
                if entries.len() > 1_000 || entries.iter().any(|entry| entry.is_empty() || entry.len() > 128 || entry.chars().any(char::is_control)) {
                    return Err("invalid legacy key IP allowlist; no keys imported");
                }
            }
            if !empty_list(get("allowed_quotas")?.as_deref())? { return Err("legacy key policy is unsupported; no keys imported"); }
            // The self-service and management scopes import; any other
            // legacy scope has no native client-key equivalent yet.
            let scopes = import_self_service_scopes(get("scopes")?.as_deref())?;
            // stream_default_mode=json only changes the legacy stream default for
            // source formats other than Chat Completions, Messages and Responses,
            // where an omitted `stream` is already non-streaming unless SSE is
            // explicitly accepted. The native Gemini surface takes streaming from
            // the method in the URL, so both modes import with the same behavior.
            let allowed_endpoints = import_endpoint_grants(get("allowed_endpoints")?.as_deref())?;
            if !matches!(get("model_access_mode")?.as_deref(), Some("all" | "restricted")) || !matches!(get("stream_default_mode")?.as_deref(), Some("legacy" | "json")) || !matches!(get("cache_default_mode")?.as_deref(), Some("legacy" | "bypass")) {
                return Err("legacy key behavior is unsupported; no keys imported");
            }
            // The catalog scope and auto-combo listing shape what the key
            // lists in /v1/models (client_key_catalog).
            let catalog = crate::client_key_catalog::CatalogPolicy {
                catalog_scope: get("catalog_scope")?
                    .as_deref()
                    .and_then(crate::client_key_catalog::CatalogScope::parse_legacy)
                    .ok_or("unsupported legacy catalog scope; no keys imported")?,
                list_auto_combos: match number("allow_auto_combos")? {
                    Some(1) => true,
                    Some(0) => false,
                    _ => return Err("invalid legacy auto-combo listing flag; no keys imported"),
                },
                public_models_only: match number("disable_non_public_models")? {
                    None | Some(0) => false,
                    Some(1) => true,
                    _ => return Err("invalid legacy public-model restriction; no keys imported"),
                },
            }
            .encode();
            let raw_combos = get("allowed_combos")?;
            let allowed_connections = import_connection_grants(get("allowed_connections")?.as_deref())?;
            let allowed_models = import_model_patterns(get("allowed_models")?.as_deref())?;
            let blocked_models = import_model_patterns(get("blocked_models")?.as_deref())?;
            // Empty policies also retain the source semantics: adding patterns
            // later must not reinterpret '*' or turn inherited combo access into
            // an explicit grant that bypasses newly added model restrictions.
            let matching = crate::model_permissions::ModelMatching::Legacy { prefer_claude_code };
            let allowed_models = crate::model_permissions::encode(allowed_models, matching)?;
            let blocked_models = serde_json::to_string(&blocked_models).map_err(|_| "invalid legacy model patterns")?;
            if raw_combos.as_ref().is_some_and(|value| value.len() > 65_536) { return Err("legacy combo policy is too large"); }
            let combos: Option<Vec<String>> = match raw_combos.as_deref() {
                None => None,
                Some(value) => serde_json::from_str(value).map_err(|_| "invalid legacy combo grants")?,
            };
            // Null remains distinct from explicit all, including on initially
            // unrestricted keys. Future edits must retain the same target checks.
            if let Some(combos) = &combos { crate::policy::validate_combo_grants(combos)?; }
            let combos = serde_json::to_string(&combos).map_err(|_| "invalid legacy combo grants")?;
            let model_access_mode = get("model_access_mode")?.ok_or("invalid legacy model access mode")?;
            let schedule = import_schedule(get("access_schedule")?.as_deref())?;
            if get("proxy_id")?.is_some_and(|value| !value.trim().is_empty()) { return Err("legacy key policy is unsupported; no keys imported"); }
            if get("__attributes")?.is_some_and(|value| serde_json::from_str::<serde_json::Value>(&value).ok() != Some(serde_json::json!({}))) {
                return Err("legacy usage attributes require migration; no keys imported");
            }
            let format = get("__format")?.unwrap_or_else(|| "prefixed".to_owned());
            if !matches!(format.as_str(), "prefixed" | "flat") { return Err("invalid legacy key format"); }
            let active = number("is_active")?;
            let banned = number("is_banned")?;
            if !matches!(active, Some(0 | 1)) || !matches!(banned, Some(0 | 1)) { return Err("invalid legacy key status"); }
            let revoked = get("revoked_at")?;
            let enabled = active == Some(1) && banned == Some(0) && revoked.is_none();
            if enabled { source_enabled += 1; }
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
            sqlx::query("INSERT INTO redrouter_control_client_keys (id,label,key_hash,enabled,expiry_unix,scopes_json,allowed_endpoints_json,allowed_models_json,blocked_models_json,allowed_provider_ids_json,max_concurrent,max_rpm,max_rpd,revision) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,1)")
                .bind(&id).bind(&label).bind(&hash).bind(0_i64).bind(expiry).bind(&scopes).bind(allowed_endpoints).bind(allowed_models).bind(blocked_models).bind(allowed_connections).bind(max_rpm).bind(max_rpd).execute(&mut *target).await.map_err(|_| "cannot write destination key")?;
            sqlx::query("INSERT INTO redrouter_legacy_key_migration (key_id,source_is_active,source_is_banned,source_revoked_at) VALUES (?,?,?,?)")
                .bind(&id).bind(active).bind(banned).bind(revoked).execute(&mut *target).await.map_err(|_| "cannot record source key status")?;
            sqlx::query("INSERT INTO redrouter_control_client_key_preferences (key_id,model_id_format,revision) VALUES (?,?,1)").bind(&id).bind(format).execute(&mut *target).await.map_err(|_| "cannot write key format")?;
            sqlx::query("INSERT INTO redrouter_control_client_key_combo_access (key_id,allowed_combos_json,revision) VALUES (?,?,1)").bind(&id).bind(combos).execute(&mut *target).await.map_err(|_| "cannot write key combo grants")?;
            sqlx::query("INSERT INTO redrouter_control_client_key_catalog (key_id,catalog_policy_json,revision) VALUES (?,?,1)").bind(&id).bind(&catalog).execute(&mut *target).await.map_err(|_| "cannot write key catalog policy")?;
            sqlx::query("INSERT INTO redrouter_control_client_key_limits (key_id,limits_json,revision) VALUES (?,?,1)").bind(&id).bind(&limits).execute(&mut *target).await.map_err(|_| "cannot write key runtime limits")?;
            sqlx::query("INSERT INTO redrouter_control_client_key_model_access (key_id,model_access_mode,revision) VALUES (?,?,1)").bind(&id).bind(model_access_mode).execute(&mut *target).await.map_err(|_| "cannot write key model access mode")?;
            sqlx::query("INSERT INTO redrouter_control_client_key_schedules (key_id,schedule_json,revision) VALUES (?,?,1)").bind(&id).bind(schedule).execute(&mut *target).await.map_err(|_| "cannot write key schedule")?;
            sqlx::query("INSERT INTO redrouter_control_client_key_ownership (key_id,tenant_id,created_by,revision) VALUES (?,?,'legacy-migration',1)").bind(&id).bind(&tenant).execute(&mut *target).await.map_err(|_| "cannot write key ownership")?;
            sqlx::query("INSERT INTO redrouter_control_client_key_quotas (key_id,max_tokens_per_minute,max_tokens_per_day,max_monthly_microusd,reservation_tokens,reservation_microusd,revision) VALUES (?,0,0,0,0,0,1)").bind(&id).execute(&mut *target).await.map_err(|_| "cannot write key quota")?;
        }
        Ok(KeyImport { imported: rows.len() as u64, disabled: rows.len() as u64, source_enabled })
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
    }.await;
    let output_close = output.close().await;
    let input_close = input.close().await;
    if output_close.is_err() || input_close.is_err() {
        return Err("cannot close migration database");
    }
    result
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn import_model_patterns(raw: Option<&str>) -> Result<Vec<String>, &'static str> {
    if raw.is_some_and(|value| value.len() > 65_536) {
        return Err("legacy model policy is too large");
    }
    let patterns: Option<Vec<String>> = match raw.filter(|value| !value.trim().is_empty()) {
        Some(value) => serde_json::from_str(value).map_err(|_| "invalid legacy model patterns")?,
        None => None,
    };
    let patterns = patterns.unwrap_or_default();
    crate::model_permissions::ModelMatching::Legacy {
        prefer_claude_code: false,
    }
    .validate(&patterns)?;
    Ok(patterns)
}

fn import_connection_grants(raw: Option<&str>) -> Result<String, &'static str> {
    if raw.is_some_and(|value| value.len() > 65_536) {
        return Err("legacy provider connection grants are too large");
    }
    let grants: Option<Vec<String>> = match raw.filter(|value| !value.trim().is_empty()) {
        Some(value) => {
            serde_json::from_str(value).map_err(|_| "invalid legacy provider connection grants")?
        }
        None => None,
    };
    let grants = grants.unwrap_or_default();
    if grants.len() > 128 || grants.iter().any(|id| !valid_id(id)) {
        return Err("invalid legacy provider connection grants");
    }
    // Provider adoption preserves connection IDs. Keep even dangling grants:
    // dropping them could turn a restricted key into an unrestricted empty list.
    // These are connection IDs, never provider family names or wildcard scopes.
    serde_json::to_string(&grants).map_err(|_| "invalid legacy provider connection grants")
}

fn import_schedule(raw: Option<&str>) -> Result<String, &'static str> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(String::new());
    };
    if raw.len() > 4096 {
        return Err("legacy access schedule is too large; no keys imported");
    }
    let schedule: Option<crate::policy::AccessScheduleConfig> = serde_json::from_str(raw)
        .map_err(|_| "invalid legacy access schedule; no keys imported")?;
    let Some(schedule) = schedule else {
        return Ok(String::new());
    };
    schedule.validate()?;
    serde_json::to_string(&schedule).map_err(|_| "cannot encode legacy access schedule")
}
/// Legacy endpoint categories as native grants. The native router gates
/// `chat`, `embeddings` and `rerank`; the legacy `models` category has no
/// native gate (listing stays available). A list that keeps no native
/// category cannot be expressed, since an empty native list allows all.
fn import_endpoint_grants(value: Option<&str>) -> Result<String, &'static str> {
    let categories = match value {
        None | Some("") => Vec::new(),
        Some(raw) => {
            serde_json::from_str::<Vec<String>>(raw).map_err(|_| "invalid legacy key policy")?
        }
    };
    if categories.len() > 20 {
        return Err("legacy key policy is unsupported; no keys imported");
    }
    let mut grants: Vec<String> = Vec::new();
    for category in &categories {
        match category.as_str() {
            "chat" | "embeddings" | "rerank" => {
                if !grants.contains(category) {
                    grants.push(category.clone());
                }
            }
            "models" => {}
            _ => return Err("legacy key policy is unsupported; no keys imported"),
        }
    }
    if !categories.is_empty() && grants.is_empty() {
        return Err("legacy key policy is unsupported; no keys imported");
    }
    serde_json::to_string(&grants).map_err(|_| "invalid legacy key policy")
}

/// A legacy key's custom rate rules (`{limit, window}` in seconds, fixed
/// windows) as native per-minute and per-day limits, or `None` when it has
/// none. Several rules on one window keep the strictest; the native sliding
/// windows never admit more requests. Other windows have no native limit.
fn import_rate_rules(value: Option<&str>) -> Result<Option<(i64, i64)>, &'static str> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Rule {
        limit: i64,
        window: i64,
    }
    let rules: Vec<Rule> = match value.map(str::trim) {
        None | Some("" | "null") => return Ok(None),
        Some(raw) => serde_json::from_str(raw)
            .map_err(|_| "invalid legacy key rate rules; no keys imported")?,
    };
    if rules.is_empty() {
        return Ok(None);
    }
    let (mut rpm, mut rpd) = (0_i64, 0_i64);
    for rule in rules {
        let (slot, max) = match rule.window {
            60 => (&mut rpm, 10_000),
            86_400 => (&mut rpd, 10_000_000),
            _ => return Err("legacy key rate window requires migration; no keys imported"),
        };
        if !(1..=max).contains(&rule.limit) {
            return Err("unsupported legacy request limit; no keys imported");
        }
        *slot = if *slot == 0 {
            rule.limit
        } else {
            (*slot).min(rule.limit)
        };
    }
    Ok(Some((rpm, rpd)))
}

/// The legacy key scopes as native scopes JSON: the self-service scopes
/// (`self:usage`, `self:account-quota`) and the management scopes
/// (`manage`, `admin`) have native equivalents.
fn import_self_service_scopes(value: Option<&str>) -> Result<String, &'static str> {
    let scopes: Vec<String> = match value {
        None | Some("") => Vec::new(),
        Some(raw) => serde_json::from_str(raw).map_err(|_| "invalid legacy key policy")?,
    };
    if scopes.iter().any(|scope| {
        !matches!(
            scope.as_str(),
            crate::self_service::SELF_USAGE_SCOPE
                | crate::self_service::SELF_ACCOUNT_QUOTA_SCOPE
                | crate::self_service::MANAGE_SCOPE
                | crate::self_service::ADMIN_SCOPE
        )
    }) {
        return Err("legacy key policy is unsupported; no keys imported");
    }
    let mut unique = scopes;
    unique.sort();
    unique.dedup();
    serde_json::to_string(&unique).map_err(|_| "invalid legacy key policy")
}

fn empty_list(value: Option<&str>) -> Result<bool, &'static str> {
    match value {
        None | Some("") => Ok(true),
        Some(raw) => serde_json::from_str::<Vec<String>>(raw)
            .map(|list| list.is_empty())
            .map_err(|_| "invalid legacy key policy"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_rate_rules_map_to_native_minute_and_day_limits() {
        assert_eq!(import_rate_rules(None), Ok(None));
        assert_eq!(import_rate_rules(Some(" null ")), Ok(None));
        assert_eq!(import_rate_rules(Some("[]")), Ok(None));
        assert_eq!(
            import_rate_rules(Some(r#"[{"limit":9,"window":60},{"limit":4,"window":60}]"#)),
            Ok(Some((4, 0)))
        );
        assert_eq!(
            import_rate_rules(Some(r#"[{"limit":700,"window":86400}]"#)),
            Ok(Some((0, 700)))
        );
        assert_eq!(
            import_rate_rules(Some(r#"[{"limit":10,"window":3600}]"#)),
            Err("legacy key rate window requires migration; no keys imported")
        );
        assert_eq!(
            import_rate_rules(Some(r#"[{"limit":0,"window":60}]"#)),
            Err("unsupported legacy request limit; no keys imported")
        );
        assert!(import_rate_rules(Some(r#"[{"limit":1}]"#)).is_err());
    }
}
