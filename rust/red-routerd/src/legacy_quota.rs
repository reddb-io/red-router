//! One-time, offline adoption of archived usage balances for a disabled key.
//! This preserves outstanding reservations conservatively and leaves the key
//! disabled. The caller must provide explicit per-request reservation bounds.
use futures_util::TryStreamExt;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const MAX_SAFE: i64 = 9_007_199_254_740_991;

#[derive(Debug, serde::Serialize)]
pub struct Adoption {
    pub daily_tokens: i64,
    pub monthly_microusd: i64,
    pub reservations: u64,
    pub counters: u64,
    pub model_limits: u64,
}

pub async fn adopt(
    path: &Path,
    key_id: &str,
    reservation_tokens: i64,
    reservation_microusd: i64,
) -> Result<Adoption, &'static str> {
    if key_id.is_empty()
        || key_id.len() > 128
        || !key_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid key identifier");
    }
    let now_ms = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "invalid system clock")?
            .as_millis(),
    )
    .map_err(|_| "invalid system clock")?;
    let now = OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms) * 1_000_000)
        .map_err(|_| "invalid system clock")?;
    let day_ms = now
        .date()
        .with_hms(0, 0, 0)
        .map_err(|_| "invalid system clock")?
        .assume_utc()
        .unix_timestamp()
        * 1000;
    let month_ms = now
        .replace_day(1)
        .map_err(|_| "invalid system clock")?
        .date()
        .with_hms(0, 0, 0)
        .map_err(|_| "invalid system clock")?
        .assume_utc()
        .unix_timestamp()
        * 1000;
    let path = std::fs::canonicalize(path).map_err(|_| "destination database does not exist")?;
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
        .map_err(|_| "cannot start quota adoption")?;
    let result: Result<Adoption, &'static str> = async {
        let native = sqlx::query("SELECT k.enabled,k.max_rpm,o.tenant_id,q.max_tokens_per_minute,q.max_tokens_per_day,q.max_monthly_microusd,q.reservation_tokens,q.reservation_microusd FROM redrouter_control_client_keys k JOIN redrouter_control_client_key_ownership o ON o.key_id=k.id AND o.revision=k.revision JOIN redrouter_control_client_key_quotas q ON q.key_id=k.id AND q.revision=k.revision JOIN redrouter_legacy_key_migration m ON m.key_id=k.id WHERE k.id=?")
            .bind(key_id).fetch_optional(&mut db).await.map_err(|_| "migrated key unavailable")?.ok_or("migrated key unavailable")?;
        let enabled: i64 = native.try_get("enabled").map_err(|_| "invalid migrated key")?;
        let tenant: String = native.try_get("tenant_id").map_err(|_| "invalid migrated key")?;
        if enabled != 0 || tenant.is_empty() { return Err("migrated key must remain disabled"); }
        for field in ["max_rpm", "max_tokens_per_minute", "max_tokens_per_day", "max_monthly_microusd", "reservation_tokens", "reservation_microusd"] {
            if native.try_get::<i64, _>(field).map_err(|_| "invalid migrated key")? != 0 { return Err("native quota limits already exist; nothing adopted"); }
        }
        for table in ["request_cost_ledger", "api_key_quota_limits", "api_key_daily_token_limits", "api_key_quota_counters", "api_key_usage_reservations"] {
            let exists: Option<i64> = sqlx::query_scalar::<_, Option<i64>>("SELECT row_count FROM redrouter_legacy_archive_manifest WHERE source_table=?")
                .bind(table).fetch_optional(&mut db).await.map_err(|_| "legacy quota archive unavailable")?.flatten();
            if exists.is_none() { return Err("legacy quota archive is incomplete"); }
        }
        for table in ["redrouter_legacy_quota_baselines", "redrouter_legacy_model_token_baselines", "redrouter_client_model_token_limits", "redrouter_usage_reservations", "redrouter_usage_counters", "redrouter_request_rate_counters", "redrouter_usage_ledger"] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM \"{table}\" WHERE key_id=?"))
                .bind(key_id).fetch_one(&mut db).await.map_err(|_| "native quota state unavailable")?;
            if count != 0 { return Err("native quota state already exists; nothing adopted"); }
        }
        let limits = sqlx::query("SELECT tpm_limit,rpm_limit,monthly_amount_usd FROM redrouter_legacy_api_key_quota_limits WHERE api_key_id=?")
            .bind(key_id).fetch_all(&mut db).await.map_err(|_| "cannot read legacy quota limits")?;
        let daily = sqlx::query("SELECT daily_tokens_limit FROM redrouter_legacy_api_key_daily_token_limits WHERE api_key_id=?")
            .bind(key_id).fetch_all(&mut db).await.map_err(|_| "cannot read legacy daily quota")?;
        if limits.len() > 1 || daily.len() > 1 { return Err("duplicate legacy quota limits"); }
        let tpm = limits.first().map(|row| row.try_get::<Option<i64>, _>("tpm_limit")).transpose().map_err(|_| "invalid legacy quota limits")?.flatten().unwrap_or(0);
        let rpm = limits.first().map(|row| row.try_get::<Option<i64>, _>("rpm_limit")).transpose().map_err(|_| "invalid legacy quota limits")?.flatten().unwrap_or(0);
        let usd_limit = limits.first().map(|row| row.try_get::<Option<f64>, _>("monthly_amount_usd")).transpose().map_err(|_| "invalid legacy quota limits")?.flatten().unwrap_or(0.0);
        let daily_limit = daily.first().map(|row| row.try_get::<i64, _>("daily_tokens_limit")).transpose().map_err(|_| "invalid legacy quota limits")?.unwrap_or(0);
        if !(0..=10_000).contains(&rpm) { return Err("unsupported legacy request quota"); }
        let monthly_limit = micros_floor_limit(usd_limit)?;
        if monthly_limit > 1_000_000_000_000 || reservation_microusd > 1_000_000_000_000 { return Err("legacy spend quota exceeds dashboard limits"); }
        let quota = crate::native_usage::NativeQuota { max_tokens_per_minute: tpm, max_tokens_per_day: daily_limit, max_monthly_microusd: monthly_limit, reservation_tokens, reservation_microusd }.validate()?;
        sqlx::query("UPDATE redrouter_control_client_keys SET max_rpm=? WHERE id=?")
            .bind(rpm).bind(key_id).execute(&mut db).await.map_err(|_| "cannot adopt legacy request limit")?;
        sqlx::query("UPDATE redrouter_control_client_key_quotas SET max_tokens_per_minute=?,max_tokens_per_day=?,max_monthly_microusd=?,reservation_tokens=?,reservation_microusd=? WHERE key_id=?")
            .bind(quota.max_tokens_per_minute).bind(quota.max_tokens_per_day).bind(quota.max_monthly_microusd).bind(quota.reservation_tokens).bind(quota.reservation_microusd).bind(key_id)
            .execute(&mut db).await.map_err(|_| "cannot adopt legacy usage limits")?;
        let archived_model_limits: Option<i64> = sqlx::query_scalar::<_, Option<i64>>("SELECT row_count FROM redrouter_legacy_archive_manifest WHERE source_table='api_key_token_limits'")
            .fetch_optional(&mut db).await.map_err(|_| "legacy model quota archive unavailable")?.flatten();
        let mut model_limit_count = 0_u64;
        if archived_model_limits.is_some_and(|count| count > 0) {
            let archived_counters: Option<i64> = sqlx::query_scalar::<_, Option<i64>>("SELECT row_count FROM redrouter_legacy_archive_manifest WHERE source_table='api_key_token_counters'")
                .fetch_optional(&mut db).await.map_err(|_| "legacy model quota archive unavailable")?.flatten();
            if archived_counters.is_none() { return Err("legacy model quota archive is incomplete"); }
            let model_limits = sqlx::query("SELECT id,scope_type,scope_value,token_limit,reset_interval,reset_time,enabled FROM redrouter_legacy_api_key_token_limits WHERE api_key_id=? ORDER BY __legacy_rowid")
                .bind(key_id).fetch_all(&mut db).await.map_err(|_| "cannot read legacy model quotas")?;
            if model_limits.len() > 10_000 { return Err("too many legacy model quotas"); }
            for row in model_limits {
                let enabled: i64 = row.try_get("enabled").map_err(|_| "invalid legacy model quota")?;
                if !matches!(enabled, 0 | 1) { return Err("invalid legacy model quota"); }
                if enabled == 0 { continue; }
                let id: String = row.try_get("id").map_err(|_| "invalid legacy model quota")?;
                let scope: String = row.try_get("scope_type").map_err(|_| "invalid legacy model quota")?;
                let model: String = row.try_get("scope_value").map_err(|_| "invalid legacy model quota")?;
                let maximum: i64 = row.try_get("token_limit").map_err(|_| "invalid legacy model quota")?;
                let interval: String = row.try_get("reset_interval").map_err(|_| "invalid legacy model quota")?;
                let reset_time: Option<String> = row.try_get("reset_time").map_err(|_| "invalid legacy model quota")?;
                if scope != "model" || id.is_empty() || id.len() > 128 || id.chars().any(char::is_control)
                    || model.trim() != model || model.is_empty() || model.len() > 256 || model.chars().any(char::is_control)
                    || !(1..=MAX_SAFE).contains(&maximum) || reservation_tokens <= 0 || reservation_tokens > maximum
                { return Err("unsupported legacy model quota"); }
                let reset_minutes = reset_minutes(reset_time.as_deref().unwrap_or("00:00"))?;
                let window = crate::native_usage::model_window_start(now_ms, &interval, reset_minutes)?;
                let counters = sqlx::query("SELECT tokens_used FROM redrouter_legacy_api_key_token_counters WHERE limit_id=? AND window_start=?")
                    .bind(&id).bind(window.to_string()).fetch_all(&mut db).await.map_err(|_| "cannot read legacy model quota counter")?;
                if counters.len() > 1 { return Err("duplicate legacy model quota counter"); }
                let used = counters.first().map(|counter| counter.try_get::<i64, _>("tokens_used")).transpose().map_err(|_| "invalid legacy model quota counter")?.unwrap_or(0);
                if !(0..=MAX_SAFE).contains(&used) { return Err("invalid legacy model quota counter"); }
                sqlx::query("INSERT INTO redrouter_client_model_token_limits (key_id,model,reset_interval,reset_minutes,token_limit) VALUES (?,?,?,?,?)")
                    .bind(key_id).bind(&model).bind(&interval).bind(reset_minutes).bind(maximum)
                    .execute(&mut db).await.map_err(|_| "cannot adopt legacy model quota")?;
                sqlx::query("INSERT INTO redrouter_legacy_model_token_baselines (key_id,model,reset_interval,window_start_unix_ms,tokens_used) VALUES (?,?,?,?,?)")
                    .bind(key_id).bind(model).bind(interval).bind(window).bind(used)
                    .execute(&mut db).await.map_err(|_| "cannot adopt legacy model quota baseline")?;
                model_limit_count += 1;
            }
        }
        let mut tokens = 0_i64;
        let mut usd = 0_f64;
        let mut ledger = sqlx::query("SELECT tenant_id,timestamp,tokens_input,tokens_output,amount_usd,success FROM redrouter_legacy_request_cost_ledger WHERE api_key_id=? ORDER BY __legacy_rowid")
            .bind(key_id).fetch(&mut db);
        while let Some(row) = ledger.try_next().await.map_err(|_| "cannot read legacy ledger")? {
            let timestamp: String = row.try_get("timestamp").map_err(|_| "invalid legacy ledger")?;
            let timestamp = OffsetDateTime::parse(&timestamp, &Rfc3339).map_err(|_| "invalid legacy ledger timestamp")?;
            let timestamp_ms = i64::try_from(timestamp.unix_timestamp_nanos() / 1_000_000).map_err(|_| "invalid legacy ledger timestamp")?;
            if timestamp_ms < month_ms { continue; }
            let owner: Option<String> = row.try_get("tenant_id").map_err(|_| "invalid legacy ledger")?;
            if owner.as_deref() != Some(tenant.as_str()) { return Err("legacy ledger tenant requires reconciliation"); }
            let input: i64 = row.try_get("tokens_input").map_err(|_| "invalid legacy ledger")?;
            let output: i64 = row.try_get("tokens_output").map_err(|_| "invalid legacy ledger")?;
            let amount: f64 = row.try_get("amount_usd").map_err(|_| "invalid legacy ledger")?;
            let success: i64 = row.try_get("success").map_err(|_| "invalid legacy ledger")?;
            if input < 0 || output < 0 || !amount.is_finite() || amount < 0.0 || !matches!(success,0 | 1) { return Err("invalid legacy ledger"); }
            if timestamp_ms >= day_ms {
                tokens = tokens.checked_add(input).and_then(|value| value.checked_add(output)).filter(|value| *value <= MAX_SAFE).ok_or("legacy token balance is too large")?;
            }
            if success == 1 && amount > 0.0 { usd = (usd + amount).next_up(); if !usd.is_finite() { return Err("legacy spend balance is too large"); } }
        }
        drop(ledger);
        let monthly = micros_ceil(usd)?;
        sqlx::query("INSERT INTO redrouter_legacy_quota_baselines VALUES (?,?,?,?,?,?)")
            .bind(key_id).bind(&tenant).bind(day_ms).bind(tokens).bind(month_ms).bind(monthly)
            .execute(&mut db).await.map_err(|_| "cannot write legacy quota baseline")?;
        let counters = sqlx::query("SELECT dimension_key,bucket_index,consumed,updated_at FROM redrouter_legacy_api_key_quota_counters WHERE api_key_id=? AND bucket_index IN (?,?)")
            .bind(key_id).bind(now_ms / 60_000).bind(now_ms / 60_000 - 1).fetch_all(&mut db).await.map_err(|_| "cannot read legacy quota counters")?;
        let mut counter_count = 0u64;
        for row in counters {
            let dimension: String = row.try_get("dimension_key").map_err(|_| "invalid legacy quota counter")?;
            let bucket: i64 = row.try_get("bucket_index").map_err(|_| "invalid legacy quota counter")?;
            let consumed: f64 = row.try_get("consumed").map_err(|_| "invalid legacy quota counter")?;
            let updated: i64 = row.try_get("updated_at").map_err(|_| "invalid legacy quota counter")?;
            let count = conservative_integer(consumed)?;
            match dimension.as_str() {
                "key-quota:tpm" => { sqlx::query("INSERT INTO redrouter_usage_counters (key_id,minute_bucket,consumed_tokens,updated_at_unix_ms) VALUES (?,?,?,?)")
                    .bind(key_id).bind(bucket).bind(count).bind(updated).execute(&mut db).await.map_err(|_| "cannot adopt legacy token counter")?; }
                "key-quota:rpm" => { sqlx::query("INSERT INTO redrouter_request_rate_counters (key_id,window_seconds,bucket_index,consumed_requests,updated_at_unix_ms) VALUES (?,60,?,?,?)")
                    .bind(key_id).bind(bucket).bind(count).bind(updated).execute(&mut db).await.map_err(|_| "cannot adopt legacy request counter")?; }
                _ => return Err("unsupported legacy quota counter"),
            }
            counter_count += 1;
        }
        let reservations = sqlx::query("SELECT id,reserved_tokens,reserved_usd,created_at,state,provider,model FROM redrouter_legacy_api_key_usage_reservations WHERE api_key_id=?")
            .bind(key_id).fetch_all(&mut db).await.map_err(|_| "cannot read legacy reservations")?;
        if reservations.len() > 10_000 { return Err("too many legacy reservations"); }
        for row in &reservations {
            let id: String = row.try_get("id").map_err(|_| "invalid legacy reservation")?;
            let state: String = row.try_get("state").map_err(|_| "invalid legacy reservation")?;
            let reserved: i64 = row.try_get("reserved_tokens").map_err(|_| "invalid legacy reservation")?;
            let amount: f64 = row.try_get("reserved_usd").map_err(|_| "invalid legacy reservation")?;
            let created: i64 = row.try_get("created_at").map_err(|_| "invalid legacy reservation")?;
            let provider: Option<String> = row.try_get("provider").map_err(|_| "invalid legacy reservation")?;
            let model: Option<String> = row.try_get("model").map_err(|_| "invalid legacy reservation")?;
            let provider = provider.filter(|value| !value.is_empty()).unwrap_or_else(|| "legacy-unknown".to_owned());
            let model = model.filter(|value| !value.is_empty()).unwrap_or_else(|| "legacy-unknown".to_owned());
            if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) || !matches!(state.as_str(), "reserved" | "dispatched") || !(0..=MAX_SAFE).contains(&reserved) || !(946_684_800_000..4_102_444_800_000).contains(&created) || provider.len() > 128 || model.len() > 256 { return Err("invalid legacy reservation"); }
            let micros = micros_ceil(amount)?;
            // Even a previously undispatched reservation remains a hold until
            // an explicit reconciliation proves it can safely be released.
            sqlx::query("INSERT INTO redrouter_usage_reservations (event_id,key_id,tenant_id,provider,model,reserved_tokens,reserved_microusd,created_at_unix_ms,state) VALUES (?,?,?,?,?,?,?,?,'dispatched')")
                .bind(&id).bind(key_id).bind(&tenant).bind(provider).bind(model).bind(reserved).bind(micros).bind(created)
                .execute(&mut db).await.map_err(|_| "legacy reservation conflicts with native state")?;
        }
        Ok(Adoption { daily_tokens: tokens, monthly_microusd: monthly, reservations: reservations.len() as u64, counters: counter_count, model_limits: model_limit_count })
    }.await;
    match result {
        Ok(report) => {
            sqlx::query("COMMIT")
                .execute(&mut db)
                .await
                .map_err(|_| "cannot commit quota adoption")?;
            Ok(report)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut db).await;
            Err(error)
        }
    }
}

fn conservative_integer(value: f64) -> Result<i64, &'static str> {
    if !value.is_finite() || value < 0.0 || value > MAX_SAFE as f64 {
        return Err("invalid legacy quota value");
    }
    Ok(value.ceil() as i64)
}
fn micros_ceil(usd: f64) -> Result<i64, &'static str> {
    conservative_integer(usd * 1_000_000.0)
}

fn micros_floor_limit(usd: f64) -> Result<i64, &'static str> {
    if !usd.is_finite() || usd < 0.0 {
        return Err("invalid legacy spend limit");
    }
    if usd == 0.0 {
        return Ok(0);
    }
    let value = (usd * 1_000_000.0).next_down();
    if !value.is_finite() || value < 1.0 || value > MAX_SAFE as f64 {
        return Err("unsupported legacy spend limit");
    }
    Ok(value.floor() as i64)
}

fn reset_minutes(value: &str) -> Result<i64, &'static str> {
    let (hour, minute) = value
        .split_once(':')
        .ok_or("invalid legacy model quota reset time")?;
    if hour.len() != 2
        || minute.len() != 2
        || !hour.bytes().all(|b| b.is_ascii_digit())
        || !minute.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("invalid legacy model quota reset time");
    }
    let hour: i64 = hour
        .parse()
        .map_err(|_| "invalid legacy model quota reset time")?;
    let minute: i64 = minute
        .parse()
        .map_err(|_| "invalid legacy model quota reset time")?;
    if hour > 23 || minute > 59 {
        return Err("invalid legacy model quota reset time");
    }
    Ok(hour * 60 + minute)
}
