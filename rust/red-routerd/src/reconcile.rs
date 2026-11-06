//! Explicit administrative inspection and reconciliation of pending usage.
use crate::accounting::{record_reserved_usage, ChatUsage, CompletedUsage, TokenPrices};
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
    let row = sqlx::query("SELECT api_key_id, provider, model, pricing_snapshot, state, created_at FROM api_key_usage_reservations WHERE id = ?")
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
        prices: &prices,
        timestamp_ms: timestamp,
    };
    match record_reserved_usage(&pool, &event).await {
        // The first transaction quarantines an underestimated bound. This is
        // an explicit operator reconciliation, so retry with that durable bound.
        Err("usage exceeds reservation; reconciliation required") => {
            record_reserved_usage(&pool, &event).await
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
