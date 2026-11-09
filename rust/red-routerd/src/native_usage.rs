//! Rust-owned SQLite reservations and usage ledger for native client keys.
//!
//! Admission and settlement use `BEGIN IMMEDIATE`, so independent proxy
//! processes sharing the same SQLite file serialize the quota decision rather
//! than oversubscribing it in separate read/write transactions.

use crate::accounting::{ChatUsage, TokenPrices};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sqlx::{pool::PoolConnection, Any, QueryBuilder, Row};
use std::sync::Arc;
use time::OffsetDateTime;

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MIN_USAGE_TIMESTAMP_MS: i64 = 946_684_800_000;
const MAX_USAGE_TIMESTAMP_MS: i64 = 4_102_444_800_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NativeQuota {
    pub(crate) max_tokens_per_minute: i64,
    pub(crate) max_tokens_per_day: i64,
    pub(crate) max_monthly_microusd: i64,
    pub(crate) reservation_tokens: i64,
    pub(crate) reservation_microusd: i64,
}

impl NativeQuota {
    pub(crate) fn enabled(self) -> bool {
        self.max_tokens_per_minute > 0
            || self.max_tokens_per_day > 0
            || self.max_monthly_microusd > 0
    }

    pub(crate) fn validate(self) -> Result<Self, &'static str> {
        let values = [
            self.max_tokens_per_minute,
            self.max_tokens_per_day,
            self.max_monthly_microusd,
            self.reservation_tokens,
            self.reservation_microusd,
        ];
        if values
            .iter()
            .any(|value| !(0..=MAX_SAFE_INTEGER).contains(value))
        {
            return Err("invalid client usage quota");
        }
        if self.enabled()
            && (self.reservation_tokens == 0
                || (self.max_monthly_microusd > 0 && self.reservation_microusd == 0))
        {
            return Err("usage quotas require positive reservation bounds");
        }
        if (self.max_tokens_per_minute > 0 && self.reservation_tokens > self.max_tokens_per_minute)
            || (self.max_tokens_per_day > 0 && self.reservation_tokens > self.max_tokens_per_day)
            || (self.max_monthly_microusd > 0
                && self.reservation_microusd > self.max_monthly_microusd)
        {
            return Err("usage reservation exceeds its quota");
        }
        Ok(self)
    }
}

#[derive(Clone)]
pub(crate) struct NativeUsage {
    database: Arc<crate::storage::Database>,
}

pub(crate) struct Reservation<'a> {
    pub(crate) event_id: &'a str,
    pub(crate) key_id: &'a str,
    pub(crate) tenant_id: &'a str,
    pub(crate) provider: &'a str,
    pub(crate) model: &'a str,
    pub(crate) quota: NativeQuota,
    pub(crate) now_ms: i64,
}

pub(crate) struct UsageEvent<'a> {
    pub(crate) event_id: &'a str,
    pub(crate) key_id: &'a str,
    pub(crate) tenant_id: &'a str,
    pub(crate) provider: &'a str,
    pub(crate) model: &'a str,
    pub(crate) usage: &'a ChatUsage,
    pub(crate) prices: Option<&'a TokenPrices>,
    pub(crate) now_ms: i64,
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct UsageLedgerEntry {
    pub(crate) event_id: String,
    pub(crate) key_id: String,
    pub(crate) tenant_id: String,
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) tokens_input: i64,
    pub(crate) tokens_output: i64,
    pub(crate) tokens_cache_read: i64,
    pub(crate) tokens_cache_creation: i64,
    pub(crate) tokens_reasoning: i64,
    pub(crate) amount_microusd: i64,
    pub(crate) pricing_known: bool,
    pub(crate) created_at_unix_ms: i64,
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct UsageReport {
    pub(crate) from_unix_ms: i64,
    pub(crate) to_unix_ms: i64,
    pub(crate) key_id: Option<String>,
    pub(crate) request_count: i64,
    pub(crate) priced_request_count: i64,
    pub(crate) tokens_input: i64,
    pub(crate) tokens_output: i64,
    pub(crate) tokens_cache_read: i64,
    pub(crate) tokens_cache_creation: i64,
    pub(crate) tokens_reasoning: i64,
    pub(crate) amount_microusd: i64,
    pub(crate) pending_request_count: i64,
    pub(crate) pending_reserved_tokens: i64,
    pub(crate) pending_reserved_microusd: i64,
    pub(crate) next_cursor: Option<String>,
    pub(crate) entries: Vec<UsageLedgerEntry>,
}

impl NativeUsage {
    pub(crate) fn new(database: Arc<crate::storage::Database>) -> Result<Self, &'static str> {
        database
            .sql_pool()
            .ok_or("native usage requires SQLite storage")?;
        Ok(Self { database })
    }

    pub(crate) async fn report(
        &self,
        tenant_id: Option<&str>,
        key_id: Option<&str>,
        from_unix_ms: i64,
        to_unix_ms: i64,
        limit: i64,
        cursor: Option<&str>,
    ) -> Result<UsageReport, &'static str> {
        if tenant_id.is_some_and(|value| value.is_empty() || value.len() > 128)
            || key_id.is_some_and(|value| value.is_empty() || value.len() > 128)
            || !(MIN_USAGE_TIMESTAMP_MS..MAX_USAGE_TIMESTAMP_MS).contains(&from_unix_ms)
            || !(MIN_USAGE_TIMESTAMP_MS + 1..=MAX_USAGE_TIMESTAMP_MS).contains(&to_unix_ms)
            || from_unix_ms >= to_unix_ms
            || !(1..=200).contains(&limit)
        {
            return Err("invalid usage report query");
        }
        let cursor = decode_cursor(cursor)?;
        if cursor
            .as_ref()
            .is_some_and(|(timestamp, _)| *timestamp < from_unix_ms || *timestamp >= to_unix_ms)
        {
            return Err("invalid usage report query");
        }
        let pool = self
            .database
            .sql_pool()
            .ok_or("native usage requires SQLite storage")?;
        let cursor_unix_ms = cursor
            .as_ref()
            .map_or(to_unix_ms, |(timestamp, _)| *timestamp);
        let cursor_event_id = cursor
            .as_ref()
            .map_or("", |(_, event_id)| event_id.as_str());
        let mut totals = QueryBuilder::<Any>::new("SELECT COUNT(*) AS request_count, COALESCE(SUM(pricing_known),0) AS priced_request_count, COALESCE(SUM(tokens_input),0) AS tokens_input, COALESCE(SUM(tokens_output),0) AS tokens_output, COALESCE(SUM(tokens_cache_read),0) AS tokens_cache_read, COALESCE(SUM(tokens_cache_creation),0) AS tokens_cache_creation, COALESCE(SUM(tokens_reasoning),0) AS tokens_reasoning, COALESCE(SUM(amount_microusd),0) AS amount_microusd FROM redrouter_usage_ledger WHERE created_at_unix_ms >= ");
        totals
            .push_bind(from_unix_ms)
            .push(" AND created_at_unix_ms < ")
            .push_bind(to_unix_ms);
        push_usage_filters(&mut totals, tenant_id, key_id);
        let totals = totals
            .build()
            .fetch_one(pool)
            .await
            .map_err(|_| "usage ledger unavailable")?;
        let mut pending = QueryBuilder::<Any>::new("SELECT COUNT(*) AS request_count, COALESCE(SUM(reserved_tokens),0) AS reserved_tokens, COALESCE(SUM(reserved_microusd),0) AS reserved_microusd FROM redrouter_usage_reservations WHERE created_at_unix_ms >= ");
        pending
            .push_bind(from_unix_ms)
            .push(" AND created_at_unix_ms < ")
            .push_bind(to_unix_ms);
        push_usage_filters(&mut pending, tenant_id, key_id);
        let pending = pending
            .build()
            .fetch_one(pool)
            .await
            .map_err(|_| "usage reservations unavailable")?;
        let mut rows = QueryBuilder::<Any>::new("SELECT event_id,key_id,tenant_id,provider,model,tokens_input,tokens_output,tokens_cache_read,tokens_cache_creation,tokens_reasoning,amount_microusd,pricing_known,created_at_unix_ms FROM redrouter_usage_ledger WHERE created_at_unix_ms >= ");
        rows.push_bind(from_unix_ms)
            .push(" AND created_at_unix_ms < ")
            .push_bind(to_unix_ms);
        push_usage_filters(&mut rows, tenant_id, key_id);
        rows.push(" AND (created_at_unix_ms < ")
            .push_bind(cursor_unix_ms)
            .push(" OR (created_at_unix_ms = ")
            .push_bind(cursor_unix_ms)
            .push(" AND event_id < ")
            .push_bind(cursor_event_id)
            .push(")) ORDER BY created_at_unix_ms DESC, event_id DESC LIMIT ")
            .push_bind(limit + 1);
        let mut rows = rows
            .build()
            .fetch_all(pool)
            .await
            .map_err(|_| "usage ledger unavailable")?;
        let page_size = usize::try_from(limit).map_err(|_| "invalid usage report query")?;
        let has_more = rows.len() > page_size;
        rows.truncate(page_size);
        let integer = |row: &sqlx::any::AnyRow, name| {
            row.try_get::<i64, _>(name)
                .map_err(|_| "invalid usage ledger")
        };
        let text = |row: &sqlx::any::AnyRow, name| {
            row.try_get::<String, _>(name)
                .map_err(|_| "invalid usage ledger")
        };
        let entries = rows
            .iter()
            .map(|row| {
                Ok(UsageLedgerEntry {
                    event_id: text(row, "event_id")?,
                    key_id: text(row, "key_id")?,
                    tenant_id: text(row, "tenant_id")?,
                    provider: text(row, "provider")?,
                    model: text(row, "model")?,
                    tokens_input: integer(row, "tokens_input")?,
                    tokens_output: integer(row, "tokens_output")?,
                    tokens_cache_read: integer(row, "tokens_cache_read")?,
                    tokens_cache_creation: integer(row, "tokens_cache_creation")?,
                    tokens_reasoning: integer(row, "tokens_reasoning")?,
                    amount_microusd: integer(row, "amount_microusd")?,
                    pricing_known: integer(row, "pricing_known")? == 1,
                    created_at_unix_ms: integer(row, "created_at_unix_ms")?,
                })
            })
            .collect::<Result<Vec<_>, &'static str>>()?;
        let next_cursor = if has_more {
            entries.last().map(encode_cursor).transpose()?
        } else {
            None
        };
        Ok(UsageReport {
            from_unix_ms,
            to_unix_ms,
            key_id: key_id.map(str::to_owned),
            request_count: integer(&totals, "request_count")?,
            priced_request_count: integer(&totals, "priced_request_count")?,
            tokens_input: integer(&totals, "tokens_input")?,
            tokens_output: integer(&totals, "tokens_output")?,
            tokens_cache_read: integer(&totals, "tokens_cache_read")?,
            tokens_cache_creation: integer(&totals, "tokens_cache_creation")?,
            tokens_reasoning: integer(&totals, "tokens_reasoning")?,
            amount_microusd: integer(&totals, "amount_microusd")?,
            pending_request_count: integer(&pending, "request_count")?,
            pending_reserved_tokens: integer(&pending, "reserved_tokens")?,
            pending_reserved_microusd: integer(&pending, "reserved_microusd")?,
            next_cursor,
            entries,
        })
    }

    async fn begin(&self) -> Result<PoolConnection<Any>, &'static str> {
        let pool = self
            .database
            .sql_pool()
            .ok_or("native usage requires SQLite storage")?;
        let mut connection = pool
            .acquire()
            .await
            .map_err(|_| "usage storage unavailable")?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await
            .map_err(|_| "usage storage unavailable")?;
        Ok(connection)
    }

    pub(crate) async fn reserve(
        &self,
        reservation: &Reservation<'_>,
    ) -> Result<bool, &'static str> {
        validate_identity(
            reservation.event_id,
            reservation.key_id,
            reservation.tenant_id,
        )?;
        validate_route(reservation.provider, reservation.model)?;
        let quota = reservation.quota.validate()?;
        if !quota.enabled()
            || !(MIN_USAGE_TIMESTAMP_MS..MAX_USAGE_TIMESTAMP_MS).contains(&reservation.now_ms)
        {
            return Err("invalid usage reservation");
        }
        let mut connection = self.begin().await?;
        let result = self.reserve_in(&mut connection, reservation).await;
        match result {
            Ok(allowed) => {
                sqlx::query("COMMIT")
                    .execute(&mut *connection)
                    .await
                    .map_err(|_| "usage storage unavailable")?;
                Ok(allowed)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }

    async fn reserve_in(
        &self,
        connection: &mut PoolConnection<Any>,
        reservation: &Reservation<'_>,
    ) -> Result<bool, &'static str> {
        let quota = reservation.quota;
        let bucket = reservation.now_ms / 60_000;
        let pending = sqlx::query("SELECT COUNT(*) AS count, COALESCE(SUM(reserved_tokens),0) AS tokens, COALESCE(SUM(reserved_microusd),0) AS microusd FROM redrouter_usage_reservations WHERE key_id = $1")
            .bind(reservation.key_id)
            .fetch_one(&mut **connection)
            .await
            .map_err(|_| "usage reservations unavailable")?;
        let pending_tokens: i64 = pending
            .try_get("tokens")
            .map_err(|_| "invalid usage reservation state")?;
        let pending_microusd: i64 = pending
            .try_get("microusd")
            .map_err(|_| "invalid usage reservation state")?;
        let counters = sqlx::query("SELECT COALESCE(SUM(CASE WHEN minute_bucket = $1 THEN consumed_tokens ELSE 0 END),0) AS current_tokens, COALESCE(SUM(CASE WHEN minute_bucket = $2 THEN consumed_tokens ELSE 0 END),0) AS previous_tokens FROM redrouter_usage_counters WHERE key_id = $3 AND minute_bucket IN ($1,$2)")
            .bind(bucket)
            .bind(bucket - 1)
            .bind(reservation.key_id)
            .fetch_one(&mut **connection)
            .await
            .map_err(|_| "usage counters unavailable")?;
        let current: i64 = counters
            .try_get("current_tokens")
            .map_err(|_| "invalid usage counter")?;
        let previous: i64 = counters
            .try_get("previous_tokens")
            .map_err(|_| "invalid usage counter")?;
        let previous_weight = 60_000 - reservation.now_ms.rem_euclid(60_000);
        let weighted_previous = previous
            .checked_mul(previous_weight)
            .and_then(|value| value.checked_add(59_999))
            .map(|value| value / 60_000)
            .ok_or("usage counter overflow")?;
        let used_minute = current
            .checked_add(weighted_previous)
            .ok_or("usage counter overflow")?;
        let (day_start, month_start) = boundaries(reservation.now_ms)?;
        let ledger = sqlx::query("SELECT COALESCE(SUM(CASE WHEN created_at_unix_ms >= $1 THEN tokens_input + tokens_output + tokens_reasoning ELSE 0 END),0) AS daily_tokens, COALESCE(SUM(CASE WHEN created_at_unix_ms >= $2 THEN amount_microusd ELSE 0 END),0) AS monthly_microusd FROM redrouter_usage_ledger WHERE key_id = $3")
            .bind(day_start)
            .bind(month_start)
            .bind(reservation.key_id)
            .fetch_one(&mut **connection)
            .await
            .map_err(|_| "usage ledger unavailable")?;
        let used_day: i64 = ledger
            .try_get("daily_tokens")
            .map_err(|_| "invalid usage ledger")?;
        let used_month: i64 = ledger
            .try_get("monthly_microusd")
            .map_err(|_| "invalid usage ledger")?;
        let token_total = |used: i64| {
            used.checked_add(pending_tokens)
                .and_then(|value| value.checked_add(quota.reservation_tokens))
        };
        let spend_total = used_month
            .checked_add(pending_microusd)
            .and_then(|value| value.checked_add(quota.reservation_microusd));
        let denied = (quota.max_tokens_per_minute > 0
            && token_total(used_minute).is_none_or(|value| value > quota.max_tokens_per_minute))
            || (quota.max_tokens_per_day > 0
                && token_total(used_day).is_none_or(|value| value > quota.max_tokens_per_day))
            || (quota.max_monthly_microusd > 0
                && spend_total.is_none_or(|value| value > quota.max_monthly_microusd));
        if denied {
            return Ok(false);
        }
        let inserted = sqlx::query("INSERT INTO redrouter_usage_reservations (event_id,key_id,tenant_id,provider,model,reserved_tokens,reserved_microusd,created_at_unix_ms,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'dispatched') ON CONFLICT (event_id) DO NOTHING")
            .bind(reservation.event_id)
            .bind(reservation.key_id)
            .bind(reservation.tenant_id)
            .bind(reservation.provider)
            .bind(reservation.model)
            .bind(quota.reservation_tokens)
            .bind(quota.reservation_microusd)
            .bind(reservation.now_ms)
            .execute(&mut **connection)
            .await
            .map_err(|_| "cannot create usage reservation")?
            .rows_affected();
        if inserted != 1 {
            return Err("usage reservation collision");
        }
        Ok(true)
    }

    pub(crate) async fn settle(&self, event: &UsageEvent<'_>) -> Result<bool, &'static str> {
        validate_identity(event.event_id, event.key_id, event.tenant_id)?;
        validate_route(event.provider, event.model)?;
        if !(MIN_USAGE_TIMESTAMP_MS..MAX_USAGE_TIMESTAMP_MS).contains(&event.now_ms) {
            return Err("invalid usage event");
        }
        let tokens =
            i64::try_from(event.usage.billable_tokens()?).map_err(|_| "invalid token usage")?;
        let amount_microusd = match event.prices {
            Some(prices) => usd_to_micros(prices.cost_usd(event.usage)?)?,
            None => 0,
        };
        let mut connection = self.begin().await?;
        let result = self
            .settle_in(&mut connection, event, tokens, amount_microusd)
            .await;
        match result {
            Ok(recorded) => {
                sqlx::query("COMMIT")
                    .execute(&mut *connection)
                    .await
                    .map_err(|_| "usage storage unavailable")?;
                Ok(recorded)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }

    async fn settle_in(
        &self,
        connection: &mut PoolConnection<Any>,
        event: &UsageEvent<'_>,
        tokens: i64,
        amount_microusd: i64,
    ) -> Result<bool, &'static str> {
        let reservation = sqlx::query("SELECT key_id,tenant_id,provider,model,reserved_tokens,reserved_microusd,state FROM redrouter_usage_reservations WHERE event_id = $1")
            .bind(event.event_id)
            .fetch_optional(&mut **connection)
            .await
            .map_err(|_| "usage reservation unavailable")?;
        let Some(reservation) = reservation else {
            let exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM redrouter_usage_ledger WHERE event_id = $1",
            )
            .bind(event.event_id)
            .fetch_one(&mut **connection)
            .await
            .map_err(|_| "usage ledger unavailable")?;
            return if exists == 1 {
                Ok(false)
            } else {
                Err("usage reservation unavailable")
            };
        };
        let text = |name| reservation.try_get::<String, _>(name).ok();
        let reserved_tokens = reservation
            .try_get::<i64, _>("reserved_tokens")
            .map_err(|_| "invalid usage reservation")?;
        let reserved_microusd = reservation
            .try_get::<i64, _>("reserved_microusd")
            .map_err(|_| "invalid usage reservation")?;
        if text("key_id").as_deref() != Some(event.key_id)
            || text("tenant_id").as_deref() != Some(event.tenant_id)
            || text("provider").as_deref() != Some(event.provider)
            || text("model").as_deref() != Some(event.model)
            || text("state").as_deref() != Some("dispatched")
            || reserved_tokens < 0
            || reserved_microusd < 0
        {
            return Err("invalid usage reservation");
        }
        if tokens > reserved_tokens || amount_microusd > reserved_microusd {
            sqlx::query("UPDATE redrouter_usage_reservations SET reserved_tokens = $2, reserved_microusd = $2 WHERE event_id = $1")
                .bind(event.event_id)
                .bind(MAX_SAFE_INTEGER)
                .execute(&mut **connection)
                .await
                .map_err(|_| "usage reservation unavailable")?;
            return Err("usage exceeds reservation; reconciliation required");
        }
        let input = i64::try_from(event.usage.input).map_err(|_| "invalid token usage")?;
        let output = i64::try_from(event.usage.output).map_err(|_| "invalid token usage")?;
        let cache_read =
            i64::try_from(event.usage.cache_read).map_err(|_| "invalid token usage")?;
        let cache_creation =
            i64::try_from(event.usage.cache_creation).map_err(|_| "invalid token usage")?;
        let reasoning = i64::try_from(event.usage.reasoning).map_err(|_| "invalid token usage")?;
        sqlx::query("INSERT INTO redrouter_usage_ledger (event_id,key_id,tenant_id,provider,model,tokens_input,tokens_output,tokens_cache_read,tokens_cache_creation,tokens_reasoning,amount_microusd,pricing_known,created_at_unix_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)")
            .bind(event.event_id)
            .bind(event.key_id)
            .bind(event.tenant_id)
            .bind(event.provider)
            .bind(event.model)
            .bind(input)
            .bind(output)
            .bind(cache_read)
            .bind(cache_creation)
            .bind(reasoning)
            .bind(amount_microusd)
            .bind(i64::from(event.prices.is_some()))
            .bind(event.now_ms)
            .execute(&mut **connection)
            .await
            .map_err(|_| "cannot record usage ledger")?;
        if tokens > 0 {
            sqlx::query("INSERT INTO redrouter_usage_counters (key_id,minute_bucket,consumed_tokens,updated_at_unix_ms) VALUES ($1,$2,$3,$4) ON CONFLICT (key_id,minute_bucket) DO UPDATE SET consumed_tokens = redrouter_usage_counters.consumed_tokens + excluded.consumed_tokens, updated_at_unix_ms = excluded.updated_at_unix_ms")
                .bind(event.key_id)
                .bind(event.now_ms / 60_000)
                .bind(tokens)
                .bind(event.now_ms)
                .execute(&mut **connection)
                .await
                .map_err(|_| "cannot update usage counter")?;
        }
        sqlx::query("DELETE FROM redrouter_usage_reservations WHERE event_id = $1")
            .bind(event.event_id)
            .execute(&mut **connection)
            .await
            .map_err(|_| "cannot settle usage reservation")?;
        Ok(true)
    }
}

fn push_usage_filters<'a>(
    query: &mut QueryBuilder<'a, Any>,
    tenant_id: Option<&'a str>,
    key_id: Option<&'a str>,
) {
    if let Some(tenant_id) = tenant_id {
        query.push(" AND tenant_id = ").push_bind(tenant_id);
    }
    if let Some(key_id) = key_id {
        query.push(" AND key_id = ").push_bind(key_id);
    }
}

fn encode_cursor(entry: &UsageLedgerEntry) -> Result<String, &'static str> {
    if entry.event_id.is_empty() || entry.event_id.len() > 128 {
        return Err("invalid usage ledger");
    }
    Ok(format!(
        "{}.{}",
        entry.created_at_unix_ms,
        URL_SAFE_NO_PAD.encode(entry.event_id.as_bytes())
    ))
}

fn decode_cursor(value: Option<&str>) -> Result<Option<(i64, String)>, &'static str> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_empty() || value.len() > 256 {
        return Err("invalid usage report query");
    }
    let (timestamp, event_id) = value.split_once('.').ok_or("invalid usage report query")?;
    let timestamp = timestamp
        .parse::<i64>()
        .map_err(|_| "invalid usage report query")?;
    let event_id = URL_SAFE_NO_PAD
        .decode(event_id)
        .map_err(|_| "invalid usage report query")?;
    let event_id = String::from_utf8(event_id).map_err(|_| "invalid usage report query")?;
    if event_id.is_empty() || event_id.len() > 128 {
        return Err("invalid usage report query");
    }
    Ok(Some((timestamp, event_id)))
}

fn validate_identity(event_id: &str, key_id: &str, tenant_id: &str) -> Result<(), &'static str> {
    if event_id.is_empty()
        || event_id.len() > 128
        || key_id.is_empty()
        || key_id.len() > 128
        || tenant_id.is_empty()
        || tenant_id.len() > 128
    {
        return Err("invalid usage identity");
    }
    Ok(())
}

fn validate_route(provider: &str, model: &str) -> Result<(), &'static str> {
    if provider.is_empty() || provider.len() > 128 || model.is_empty() || model.len() > 256 {
        return Err("invalid usage route");
    }
    Ok(())
}

fn boundaries(now_ms: i64) -> Result<(i64, i64), &'static str> {
    let now = OffsetDateTime::from_unix_timestamp_nanos(now_ms as i128 * 1_000_000)
        .map_err(|_| "invalid usage timestamp")?;
    let day = now
        .date()
        .with_hms(0, 0, 0)
        .map_err(|_| "invalid usage timestamp")?
        .assume_utc()
        .unix_timestamp_nanos()
        / 1_000_000;
    let month = now
        .replace_day(1)
        .map_err(|_| "invalid usage timestamp")?
        .date()
        .with_hms(0, 0, 0)
        .map_err(|_| "invalid usage timestamp")?
        .assume_utc()
        .unix_timestamp_nanos()
        / 1_000_000;
    Ok((
        i64::try_from(day).map_err(|_| "invalid usage timestamp")?,
        i64::try_from(month).map_err(|_| "invalid usage timestamp")?,
    ))
}

fn usd_to_micros(usd: f64) -> Result<i64, &'static str> {
    let micros = usd * 1_000_000.0;
    if !micros.is_finite() || micros < 0.0 || micros > MAX_SAFE_INTEGER as f64 {
        return Err("invalid usage cost");
    }
    Ok(micros.ceil() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{Backend, Database};
    use tempfile::TempDir;
    use url::Url;

    fn sqlite_url(folder: &TempDir) -> String {
        let file = Url::from_file_path(folder.path().join("native-usage.sqlite")).unwrap();
        format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1))
    }

    fn quota() -> NativeQuota {
        NativeQuota {
            max_tokens_per_minute: 100,
            max_tokens_per_day: 1_000,
            max_monthly_microusd: 1_000_000,
            reservation_tokens: 60,
            reservation_microusd: 100_000,
        }
    }

    #[tokio::test]
    async fn concurrent_reservations_cannot_oversubscribe_a_key() {
        let folder = TempDir::new().unwrap();
        let database = Arc::new(
            Database::connect(Backend::Sqlite, &sqlite_url(&folder))
                .await
                .unwrap(),
        );
        let usage = NativeUsage::new(database).unwrap();
        let tasks = (0..16)
            .map(|index| {
                let usage = usage.clone();
                tokio::spawn(async move {
                    let event_id = format!("event-{index}");
                    usage
                        .reserve(&Reservation {
                            event_id: &event_id,
                            key_id: "key",
                            tenant_id: "tenant",
                            provider: "openai",
                            model: "gpt-4.1",
                            quota: quota(),
                            now_ms: 1_700_000_000_000,
                        })
                        .await
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let mut admitted = 0;
        for task in tasks {
            admitted += usize::from(task.await.unwrap());
        }
        assert_eq!(admitted, 1);
    }

    #[tokio::test]
    async fn settlement_survives_restart_and_counts_tokens_and_spend() {
        let folder = TempDir::new().unwrap();
        let url = sqlite_url(&folder);
        let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        let usage = NativeUsage::new(database.clone()).unwrap();
        assert!(usage
            .reserve(&Reservation {
                event_id: "event-one",
                key_id: "key",
                tenant_id: "tenant",
                provider: "openai",
                model: "gpt-4.1",
                quota: quota(),
                now_ms: 1_700_000_000_000,
            })
            .await
            .unwrap());
        let tokens = ChatUsage {
            input: 10,
            output: 5,
            reasoning: 2,
            cache_read: 0,
            cache_creation: 0,
        };
        let prices = TokenPrices {
            input: 2.0,
            output: 4.0,
            cache_read: 1.0,
            cache_creation: 2.0,
            reasoning: 4.0,
        };
        assert!(usage
            .settle(&UsageEvent {
                event_id: "event-one",
                key_id: "key",
                tenant_id: "tenant",
                provider: "openai",
                model: "gpt-4.1",
                usage: &tokens,
                prices: Some(&prices),
                now_ms: 1_700_000_000_100,
            })
            .await
            .unwrap());
        let ledger: (i64, i64) = sqlx::query_as(
            "SELECT tokens_input + tokens_output + tokens_reasoning, amount_microusd FROM redrouter_usage_ledger WHERE event_id = 'event-one'",
        )
        .fetch_one(database.sql_pool().unwrap())
        .await
        .unwrap();
        assert_eq!(ledger, (17, 40));
        drop(usage);
        let database = Arc::try_unwrap(database).ok().unwrap();
        database.close().await.unwrap();

        let reopened = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        let usage = NativeUsage::new(reopened).unwrap();
        assert!(usage
            .reserve(&Reservation {
                event_id: "event-two",
                key_id: "key",
                tenant_id: "tenant",
                provider: "openai",
                model: "gpt-4.1",
                quota: quota(),
                now_ms: 1_700_000_000_200,
            })
            .await
            .unwrap());
        assert!(!usage
            .reserve(&Reservation {
                event_id: "event-three",
                key_id: "key",
                tenant_id: "tenant",
                provider: "openai",
                model: "gpt-4.1",
                quota: quota(),
                now_ms: 1_700_000_000_300,
            })
            .await
            .unwrap());
    }
}
