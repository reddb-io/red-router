//! Explicit administrative inspection and reconciliation of pending usage.
use crate::accounting::{
    record_reserved_usage_with_attributes, ChatUsage, CompletedUsage, TokenPrices, UsageAttributes,
};
use serde_json::{json, Value};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row,
};
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

async fn database(path: &Path, read_only: bool) -> Result<sqlx::SqlitePool, &'static str> {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .read_only(read_only)
                .create_if_missing(false)
                .busy_timeout(Duration::from_secs(5)),
        )
        .await
        .map_err(|_| "cannot open product SQLite database")
}

/// Inspect a bounded list; this never reads API keys or provider credentials.
pub async fn list(path: &Path) -> Result<Value, &'static str> {
    let pool = database(path, true).await?;
    let rows = sqlx::query("SELECT id, api_key_id, state, created_at, reserved_tokens, reserved_usd, provider, model, connection_id FROM api_key_usage_reservations ORDER BY created_at, id LIMIT 1000")
        .fetch_all(&pool).await.map_err(|_| "reservation schema unavailable")?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.try_get("id").map_err(|_| "invalid reservation")?;
        let key: String = row
            .try_get("api_key_id")
            .map_err(|_| "invalid reservation")?;
        let state: String = row.try_get("state").map_err(|_| "invalid reservation")?;
        let created: i64 = row
            .try_get("created_at")
            .map_err(|_| "invalid reservation")?;
        let tokens: i64 = row
            .try_get("reserved_tokens")
            .map_err(|_| "invalid reservation")?;
        let usd: f64 = row
            .try_get("reserved_usd")
            .map_err(|_| "invalid reservation")?;
        let provider: Option<String> =
            row.try_get("provider").map_err(|_| "invalid reservation")?;
        let model: Option<String> = row.try_get("model").map_err(|_| "invalid reservation")?;
        let connection: Option<String> = row
            .try_get("connection_id")
            .map_err(|_| "invalid reservation")?;
        result.push(json!({"id":id,"key_id":key,"state":state,"created_at_ms":created,"reserved_tokens":tokens,"reserved_usd":usd,"provider":provider,"model":model,"connection_id":connection}));
    }
    Ok(json!({"reservations":result,"limit":1000}))
}

/// Settle only using usage explicitly supplied by the operator and the price
/// snapshot captured at dispatch. No undiscovered usage is assumed to be zero.
pub async fn reconcile(path: &Path, id: &str, response: &Value) -> Result<bool, &'static str> {
    if id.is_empty() || id.len() > 128 {
        return Err("invalid reservation ID");
    }
    let timestamp = response
        .get("timestamp_ms")
        .and_then(Value::as_i64)
        .ok_or("timestamp_ms is required")?;
    let now = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "invalid clock")?
            .as_millis(),
    )
    .map_err(|_| "invalid clock")?;
    if timestamp < 946_684_800_000 || timestamp > now.saturating_add(300_000) {
        return Err("invalid usage timestamp");
    }
    if response
        .get("service_tier")
        .is_some_and(|v| !v.is_null() && v.as_str() != Some("default"))
    {
        return Err("unsupported service tier");
    }
    let usage = ChatUsage::from_response(response)?;
    let pool = database(path, false).await?;
    let row = sqlx::query("SELECT api_key_id, provider, model, pricing_snapshot, usage_attributes, state, created_at FROM api_key_usage_reservations WHERE id = ?")
        .bind(id).fetch_optional(&pool).await.map_err(|_| "reservation unavailable")?.ok_or("reservation not found")?;
    let key: String = row
        .try_get("api_key_id")
        .map_err(|_| "invalid reservation")?;
    let provider: String = row
        .try_get("provider")
        .map_err(|_| "reservation has no provider metadata")?;
    let model: String = row
        .try_get("model")
        .map_err(|_| "reservation has no model metadata")?;
    let snapshot: String = row
        .try_get("pricing_snapshot")
        .map_err(|_| "reservation has no pricing snapshot")?;
    let usage_attributes: String = row
        .try_get("usage_attributes")
        .map_err(|_| "reservation has no usage attributes")?;
    let usage_attributes = UsageAttributes::parse(&usage_attributes)?;
    let state: String = row.try_get("state").map_err(|_| "invalid reservation")?;
    let created: i64 = row
        .try_get("created_at")
        .map_err(|_| "invalid reservation")?;
    if state != "dispatched" || timestamp < created {
        return Err("reservation is not dispatched or timestamp predates it");
    }
    let pricing: Value = serde_json::from_str(&snapshot).map_err(|_| "invalid pricing snapshot")?;
    let prices = TokenPrices::from_record(&pricing)?;
    let event = CompletedUsage {
        event_id: id,
        key_id: &key,
        provider: &provider,
        model: &model,
        usage: &usage,
        prices: Some(&prices),
        timestamp_ms: timestamp,
    };
    match record_reserved_usage_with_attributes(&pool, &event, &usage_attributes).await {
        // The first transaction quarantines an underestimated bound. This is
        // an explicit operator reconciliation, so retry with that durable bound.
        Err("usage exceeds reservation; reconciliation required") => {
            record_reserved_usage_with_attributes(&pool, &event, &usage_attributes).await
        }
        other => other,
    }
}

/// Cancel an entry only if it was never marked dispatched.
pub async fn cancel_undispatched(path: &Path, id: &str) -> Result<bool, &'static str> {
    if id.is_empty() || id.len() > 128 {
        return Err("invalid reservation ID");
    }
    let pool = database(path, false).await?;
    let result =
        sqlx::query("DELETE FROM api_key_usage_reservations WHERE id = ? AND state = 'reserved'")
            .bind(id)
            .execute(&pool)
            .await
            .map_err(|_| "reservation unavailable")?;
    Ok(result.rows_affected() == 1)
}

/// Configure one model limit while the key and servers are offline. Imported
/// keys require separate baseline adoption and are deliberately rejected.
pub async fn configure_native_model_limit(
    path: &Path,
    key: &str,
    model: &str,
    interval: &str,
    reset_minutes: i64,
    limit: i64,
) -> Result<(), &'static str> {
    if key.is_empty()
        || key.len() > 128
        || key.chars().any(char::is_control)
        || model.is_empty()
        || model.len() > 256
        || model.trim() != model
        || model.chars().any(char::is_control)
        || !matches!(interval, "daily" | "weekly" | "monthly")
        || !(0..1440).contains(&reset_minutes)
        || !(1..=9_007_199_254_740_991).contains(&limit)
    {
        return Err("invalid model quota");
    }
    let pool = database(path, false).await?;
    let mut db = pool
        .acquire()
        .await
        .map_err(|_| "model quota storage unavailable")?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *db)
        .await
        .map_err(|_| "model quota storage unavailable")?;
    let result: Result<(), &'static str> = async {
        let row = sqlx::query("SELECT k.enabled,q.max_tokens_per_minute,q.max_tokens_per_day,q.max_monthly_microusd,q.reservation_tokens FROM redrouter_control_client_keys k JOIN redrouter_control_client_key_quotas q ON q.key_id=k.id AND q.revision=k.revision WHERE k.id=?")
            .bind(key).fetch_optional(&mut *db).await.map_err(|_| "client quota unavailable")?.ok_or("client quota unavailable")?;
        let enabled: i64 = row.try_get("enabled").map_err(|_| "invalid client quota")?;
        let reserved: i64 = row.try_get("reservation_tokens").map_err(|_| "invalid client quota")?;
        let global = ["max_tokens_per_minute", "max_tokens_per_day", "max_monthly_microusd"]
            .iter().map(|field| row.try_get::<i64, _>(*field).map_err(|_| "invalid client quota"))
            .collect::<Result<Vec<_>, _>>()?;
        if enabled != 0 || reserved <= 0 || reserved > limit || !global.iter().any(|n| *n > 0) {
            return Err("disable the key and configure a compatible global reservation first");
        }
        let legacy_table: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='redrouter_legacy_key_migration'")
            .fetch_one(&mut *db).await.map_err(|_| "migration state unavailable")?;
        if legacy_table == 1 {
            let legacy: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_legacy_key_migration WHERE key_id=?")
                .bind(key).fetch_one(&mut *db).await.map_err(|_| "migration state unavailable")?;
            if legacy != 0 { return Err("legacy model quota baseline requires migration"); }
        }
        sqlx::query("INSERT INTO redrouter_client_model_token_limits (key_id,model,reset_interval,reset_minutes,token_limit) VALUES (?,?,?,?,?) ON CONFLICT(key_id,model,reset_interval) DO UPDATE SET reset_minutes=excluded.reset_minutes,token_limit=excluded.token_limit")
            .bind(key).bind(model).bind(interval).bind(reset_minutes).bind(limit).execute(&mut *db).await.map_err(|_| "cannot configure model quota")?;
        Ok(())
    }.await;
    match result {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(&mut *db)
                .await
                .map_err(|_| "cannot commit model quota")?;
            Ok(())
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *db).await;
            Err(error)
        }
    }
}

/// Inspect native Rust reservations without exposing credentials.
pub async fn list_native(path: &Path) -> Result<Value, &'static str> {
    let pool = database(path, true).await?;
    let rows = sqlx::query("SELECT event_id,key_id,tenant_id,provider,model,quota_model,reserved_tokens,reserved_microusd,created_at_unix_ms,state FROM redrouter_usage_reservations ORDER BY created_at_unix_ms,event_id LIMIT 1000")
        .fetch_all(&pool).await.map_err(|_| "native reservation schema unavailable")?;
    let mut reservations = Vec::with_capacity(rows.len());
    for row in rows {
        reservations.push(json!({
            "id": row.try_get::<String, _>("event_id").map_err(|_| "invalid reservation")?,
            "key_id": row.try_get::<String, _>("key_id").map_err(|_| "invalid reservation")?,
            "tenant_id": row.try_get::<String, _>("tenant_id").map_err(|_| "invalid reservation")?,
            "provider": row.try_get::<String, _>("provider").map_err(|_| "invalid reservation")?,
            "model": row.try_get::<String, _>("model").map_err(|_| "invalid reservation")?,
            "quota_model": row.try_get::<String, _>("quota_model").map_err(|_| "invalid reservation")?,
            "reserved_tokens": row.try_get::<i64, _>("reserved_tokens").map_err(|_| "invalid reservation")?,
            "reserved_microusd": row.try_get::<i64, _>("reserved_microusd").map_err(|_| "invalid reservation")?,
            "created_at_ms": row.try_get::<i64, _>("created_at_unix_ms").map_err(|_| "invalid reservation")?,
            "state": row.try_get::<String, _>("state").map_err(|_| "invalid reservation")?,
        }));
    }
    Ok(json!({"reservations": reservations, "limit": 1000}))
}

/// Atomically replace a native hold with explicitly verified usage and cost.
/// The caller must verify that the original request was not already included
/// in a migrated baseline before supplying this accounting evidence.
pub async fn reconcile_native(path: &Path, id: &str, response: &Value) -> Result<(), &'static str> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err("invalid reservation ID");
    }
    let usage = ChatUsage::from_response(response)?;
    let tokens = i64::try_from(usage.billable_tokens()?).map_err(|_| "invalid token usage")?;
    const MAX_SAFE: i64 = 9_007_199_254_740_991;
    if tokens > MAX_SAFE {
        return Err("invalid token usage");
    }
    let amount = response
        .get("amount_microusd")
        .and_then(Value::as_i64)
        .filter(|v| (0..=MAX_SAFE).contains(v))
        .ok_or("verified amount_microusd is required")?;
    let evidence = response
        .get("evidence")
        .and_then(Value::as_str)
        .filter(|v| (10..=512).contains(&v.trim().len()) && !v.chars().any(char::is_control))
        .ok_or("accounting evidence is required")?
        .trim();
    let timestamp = response
        .get("timestamp_ms")
        .and_then(Value::as_i64)
        .ok_or("timestamp_ms is required")?;
    let now = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "invalid clock")?
            .as_millis(),
    )
    .map_err(|_| "invalid clock")?;
    if !(946_684_800_000..4_102_444_800_000).contains(&timestamp)
        || timestamp > now.saturating_add(300_000)
    {
        return Err("invalid usage timestamp");
    }
    let pool = database(path, false).await?;
    let mut db = pool
        .acquire()
        .await
        .map_err(|_| "native reservation unavailable")?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *db)
        .await
        .map_err(|_| "cannot lock native reservations")?;
    let result: Result<(), &'static str> = async {
        let row = sqlx::query("SELECT r.key_id,r.tenant_id,r.provider,r.model,r.quota_model,r.state,r.created_at_unix_ms,k.label FROM redrouter_usage_reservations r JOIN redrouter_control_client_keys k ON k.id=r.key_id JOIN redrouter_control_client_key_ownership o ON o.key_id=k.id AND o.tenant_id=r.tenant_id WHERE r.event_id=?")
            .bind(id).fetch_optional(&mut *db).await.map_err(|_| "native reservation unavailable")?.ok_or("native reservation not found")?;
        let key: String = row.try_get("key_id").map_err(|_| "invalid native reservation")?;
        let tenant: String = row.try_get("tenant_id").map_err(|_| "invalid native reservation")?;
        let provider: String = row.try_get("provider").map_err(|_| "invalid native reservation")?;
        let model: String = row.try_get("model").map_err(|_| "invalid native reservation")?;
        let quota_model: String = row.try_get("quota_model").map_err(|_| "invalid native reservation")?;
        let label: String = row.try_get("label").map_err(|_| "invalid native reservation")?;
        let state: String = row.try_get("state").map_err(|_| "invalid native reservation")?;
        let created: i64 = row.try_get("created_at_unix_ms").map_err(|_| "invalid native reservation")?;
        if state != "dispatched" || timestamp < created { return Err("reservation is not dispatched or timestamp predates it"); }
        if quota_model.len() > 256 || quota_model.chars().any(char::is_control) {
            return Err("invalid native reservation");
        }
        let snapshot = json!({"currency":"USD","source":"operator-reconciliation","evidence":evidence}).to_string();
        sqlx::query("INSERT INTO redrouter_usage_ledger (event_id,key_id,key_name,tenant_id,provider,model,quota_model,usage_kind,search_units,tokens_input,tokens_output,tokens_cache_read,tokens_cache_creation,tokens_reasoning,amount_microusd,pricing_known,pricing_snapshot,created_at_unix_ms) VALUES (?,?,?,?,?,?,?,'tokens',0,?,?,?,?,?,?,1,?,?)")
            .bind(id).bind(&key).bind(label).bind(tenant).bind(provider).bind(model).bind(quota_model)
            .bind(usage.input as i64).bind(usage.output as i64).bind(usage.cache_read as i64).bind(usage.cache_creation as i64).bind(usage.reasoning as i64).bind(amount).bind(snapshot).bind(timestamp)
            .execute(&mut *db).await.map_err(|_| "cannot record reconciled usage")?;
        if tokens > 0 {
            sqlx::query("INSERT INTO redrouter_usage_counters (key_id,minute_bucket,consumed_tokens,updated_at_unix_ms) VALUES (?,?,?,?) ON CONFLICT (key_id,minute_bucket) DO UPDATE SET consumed_tokens=redrouter_usage_counters.consumed_tokens+excluded.consumed_tokens,updated_at_unix_ms=excluded.updated_at_unix_ms")
                .bind(key).bind(timestamp / 60_000).bind(tokens).bind(timestamp).execute(&mut *db).await.map_err(|_| "cannot update usage counter")?;
        }
        let removed = sqlx::query("DELETE FROM redrouter_usage_reservations WHERE event_id=? AND state='dispatched'")
            .bind(id).execute(&mut *db).await.map_err(|_| "cannot settle native reservation")?;
        if removed.rows_affected() != 1 { return Err("native reservation changed"); }
        Ok(())
    }.await;
    match result {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(&mut *db)
                .await
                .map_err(|_| "cannot commit reconciliation")?;
            Ok(())
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *db).await;
            Err(error)
        }
    }
}
