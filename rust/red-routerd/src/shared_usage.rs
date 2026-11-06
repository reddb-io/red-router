//! Durable shared usage reservations. These are not yet wired to proxy traffic.
use sqlx::{Row, SqlitePool};

pub struct UsageReservation<'a> {
    pub id: &'a str,
    pub key_id: &'a str,
    pub tokens: i64,
    pub usd: f64,
    pub now_ms: i64,
}

fn amount(value: f64) -> Result<f64, &'static str> {
    if value.is_finite() && value >= 0.0 {
        Ok(value)
    } else {
        Err("invalid usage reservation value")
    }
}

/// Reserve an upper bound in a write transaction shared by Rust and TypeScript.
/// Dispatched reservations never expire and need explicit reconciliation.
pub async fn reserve_usage(
    pool: &SqlitePool,
    r: &UsageReservation<'_>,
) -> Result<bool, &'static str> {
    if r.id.is_empty()
        || r.id.len() > 128
        || r.key_id.is_empty()
        || r.key_id.len() > 512
        || r.tokens < 0
        || r.tokens > 9_007_199_254_740_991
        || r.now_ms < 946_684_800_000
        || r.now_ms >= 4_102_444_800_000
    {
        return Err("invalid usage reservation");
    }
    amount(r.usd)?;
    let bucket = r.now_ms / 60_000;
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|_| "reservation database unavailable")?;
    let limits = sqlx::query(
        "SELECT tpm_limit, monthly_amount_usd FROM api_key_quota_limits WHERE api_key_id = ?",
    )
    .bind(r.key_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| "reservation limits unavailable")?;
    let (tpm_limit, usd_limit) = if let Some(row) = limits {
        (
            amount(
                row.try_get::<Option<i64>, _>("tpm_limit")
                    .map_err(|_| "invalid limit")?
                    .unwrap_or(0) as f64,
            )?,
            amount(
                row.try_get::<Option<f64>, _>("monthly_amount_usd")
                    .map_err(|_| "invalid limit")?
                    .unwrap_or(0.0),
            )?,
        )
    } else {
        (0.0, 0.0)
    };
    let daily: Option<i64> = sqlx::query_scalar(
        "SELECT daily_tokens_limit FROM api_key_daily_token_limits WHERE api_key_id = ?",
    )
    .bind(r.key_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| "reservation daily limit unavailable")?;
    let day_limit = amount(daily.unwrap_or(0) as f64)?;
    let outstanding = sqlx::query("SELECT CAST(COALESCE(SUM(reserved_tokens),0) AS REAL) AS tokens, CAST(COALESCE(SUM(reserved_usd),0) AS REAL) AS usd FROM api_key_usage_reservations WHERE api_key_id = ?")
        .bind(r.key_id).fetch_one(&mut *tx).await.map_err(|_| "reservation state unavailable")?;
    let pending_tokens = amount(
        outstanding
            .try_get("tokens")
            .map_err(|_| "invalid reservation")?,
    )?;
    let pending_usd = amount(
        outstanding
            .try_get("usd")
            .map_err(|_| "invalid reservation")?,
    )?;
    let counters = sqlx::query("SELECT CAST(COALESCE(SUM(CASE WHEN bucket_index = ? THEN consumed ELSE 0 END),0) AS REAL) AS current, CAST(COALESCE(SUM(CASE WHEN bucket_index = ? THEN consumed ELSE 0 END),0) AS REAL) AS previous FROM api_key_quota_counters WHERE api_key_id = ? AND dimension_key = 'key-quota:tpm' AND bucket_index IN (?, ?)")
        .bind(bucket).bind(bucket - 1).bind(r.key_id).bind(bucket).bind(bucket - 1)
        .fetch_one(&mut *tx).await.map_err(|_| "reservation counters unavailable")?;
    let used_tpm = amount(counters.try_get("current").map_err(|_| "invalid counter")?)?
        + amount(
            counters
                .try_get("previous")
                .map_err(|_| "invalid counter")?,
        )? * (1.0 - (r.now_ms % 60_000) as f64 / 60_000.0);
    let ledger = sqlx::query("SELECT CAST(COALESCE(SUM(CASE WHEN timestamp >= strftime('%Y-%m-%dT00:00:00.000Z', ? / 1000.0, 'unixepoch') THEN tokens_input + tokens_output ELSE 0 END),0) AS REAL) AS tokens, CAST(COALESCE(SUM(CASE WHEN timestamp >= strftime('%Y-%m-01T00:00:00.000Z', ? / 1000.0, 'unixepoch') AND success = 1 THEN amount_usd ELSE 0 END),0) AS REAL) AS usd FROM request_cost_ledger WHERE api_key_id = ?")
        .bind(r.now_ms).bind(r.now_ms).bind(r.key_id).fetch_one(&mut *tx).await.map_err(|_| "reservation ledger unavailable")?;
    let used_day = amount(ledger.try_get("tokens").map_err(|_| "invalid ledger")?)?;
    let used_usd = amount(ledger.try_get("usd").map_err(|_| "invalid ledger")?)?;
    if (tpm_limit > 0.0 && used_tpm + pending_tokens + r.tokens as f64 > tpm_limit)
        || (day_limit > 0.0 && used_day + pending_tokens + r.tokens as f64 > day_limit)
        || (usd_limit > 0.0 && used_usd + pending_usd + r.usd > usd_limit)
    {
        tx.commit()
            .await
            .map_err(|_| "reservation database unavailable")?;
        return Ok(false);
    }
    sqlx::query("INSERT INTO api_key_usage_reservations(id, api_key_id, reserved_tokens, reserved_usd, created_at, state) VALUES (?, ?, ?, ?, ?, 'reserved')")
        .bind(r.id).bind(r.key_id).bind(r.tokens).bind(r.usd).bind(r.now_ms).execute(&mut *tx).await
        .map_err(|_| "reservation insert failed")?;
    tx.commit()
        .await
        .map_err(|_| "reservation database unavailable")?;
    Ok(true)
}

pub async fn mark_dispatched(
    pool: &SqlitePool,
    id: &str,
    key_id: &str,
) -> Result<bool, &'static str> {
    let result = sqlx::query("UPDATE api_key_usage_reservations SET state = 'dispatched' WHERE id = ? AND api_key_id = ? AND state IN ('reserved','dispatched')")
        .bind(id).bind(key_id).execute(pool).await.map_err(|_| "reservation state unavailable")?;
    Ok(result.rows_affected() == 1)
}

pub async fn cancel_undispatched(
    pool: &SqlitePool,
    id: &str,
    key_id: &str,
) -> Result<bool, &'static str> {
    let result = sqlx::query("DELETE FROM api_key_usage_reservations WHERE id = ? AND api_key_id = ? AND state = 'reserved'")
        .bind(id).bind(key_id).execute(pool).await.map_err(|_| "reservation state unavailable")?;
    Ok(result.rows_affected() == 1)
}
