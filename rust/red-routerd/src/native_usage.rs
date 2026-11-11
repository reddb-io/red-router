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
    pub(crate) reserved_tokens: i64,
    pub(crate) reserved_microusd: i64,
    pub(crate) now_ms: i64,
}

pub(crate) struct UsageEvent<'a> {
    pub(crate) event_id: &'a str,
    pub(crate) key_id: &'a str,
    pub(crate) key_name: &'a str,
    pub(crate) tenant_id: &'a str,
    pub(crate) provider: &'a str,
    pub(crate) model: &'a str,
    pub(crate) usage: &'a ChatUsage,
    pub(crate) prices: Option<&'a TokenPrices>,
    pub(crate) kind: UsageKind,
    pub(crate) search_units: u64,
    pub(crate) rerank_price: Option<&'a RerankPrice>,
    pub(crate) now_ms: i64,
    pub(crate) reserved: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UsageKind {
    Tokens,
    Rerank,
}

impl UsageKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Tokens => "tokens",
            Self::Rerank => "rerank",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RerankPrice {
    pub(crate) per_search_unit: f64,
    pub(crate) source: &'static str,
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct UsageLedgerEntry {
    pub(crate) event_id: String,
    pub(crate) key_id: String,
    pub(crate) key_name: String,
    pub(crate) tenant_id: String,
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) usage_kind: String,
    pub(crate) search_units: i64,
    pub(crate) tokens_input: i64,
    pub(crate) tokens_output: i64,
    pub(crate) tokens_cache_read: i64,
    pub(crate) tokens_cache_creation: i64,
    pub(crate) tokens_reasoning: i64,
    pub(crate) amount_microusd: i64,
    pub(crate) pricing_known: bool,
    pub(crate) pricing_snapshot: Option<serde_json::Value>,
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
    pub(crate) search_units: i64,
    pub(crate) amount_microusd: i64,
    pub(crate) pending_request_count: i64,
    pub(crate) pending_reserved_tokens: i64,
    pub(crate) pending_reserved_microusd: i64,
    pub(crate) next_cursor: Option<String>,
    pub(crate) entries: Vec<UsageLedgerEntry>,
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct UsageMaintenanceReport {
    pub(crate) usage_counters_deleted: u64,
    pub(crate) request_counters_deleted: u64,
    pub(crate) has_more: bool,
}

impl NativeUsage {
    pub(crate) fn new(database: Arc<crate::storage::Database>) -> Result<Self, &'static str> {
        database
            .sql_pool()
            .ok_or("native usage requires SQLite storage")?;
        Ok(Self { database })
    }

    pub(crate) async fn prune_operational_state(
        &self,
        now_ms: i64,
        batch_size: i64,
    ) -> Result<UsageMaintenanceReport, &'static str> {
        if !(MIN_USAGE_TIMESTAMP_MS..MAX_USAGE_TIMESTAMP_MS).contains(&now_ms)
            || !(1..=10_000).contains(&batch_size)
        {
            return Err("invalid usage maintenance request");
        }
        let mut connection = self.begin().await?;
        let result = async {
            // Quota admission reads only the current and immediately preceding
            // minute. Older counters are operational scratch state, not ledger.
            let minute_bucket = now_ms / 60_000;
            let usage_counters_deleted = sqlx::query("DELETE FROM redrouter_usage_counters WHERE rowid IN (SELECT rowid FROM redrouter_usage_counters WHERE minute_bucket < $1 ORDER BY minute_bucket ASC LIMIT $2)")
                .bind(minute_bucket - 1)
                .bind(batch_size)
                .execute(&mut *connection)
                .await
                .map_err(|_| "cannot prune usage counters")?
                .rows_affected();

            // Request admission likewise uses two buckets for each supported
            // rolling window. Invalid internal window rows are fail-safe debris
            // and can never participate in admission, so maintenance removes them.
            let request_counters_deleted = sqlx::query("DELETE FROM redrouter_request_rate_counters WHERE rowid IN (SELECT rowid FROM redrouter_request_rate_counters WHERE (window_seconds = 60 AND bucket_index < $1) OR (window_seconds = 86400 AND bucket_index < $2) OR window_seconds NOT IN (60,86400) ORDER BY updated_at_unix_ms ASC LIMIT $3)")
                .bind(minute_bucket - 1)
                .bind(now_ms / 86_400_000 - 1)
                .bind(batch_size)
                .execute(&mut *connection)
                .await
                .map_err(|_| "cannot prune request rate-limit counters")?
                .rows_affected();
            let batch_size = u64::try_from(batch_size)
                .map_err(|_| "invalid usage maintenance request")?;
            Ok(UsageMaintenanceReport {
                usage_counters_deleted,
                request_counters_deleted,
                has_more: usage_counters_deleted == batch_size
                    || request_counters_deleted == batch_size,
            })
        }
        .await;
        match result {
            Ok(report) => {
                sqlx::query("COMMIT")
                    .execute(&mut *connection)
                    .await
                    .map_err(|_| "usage maintenance unavailable")?;
                Ok(report)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }

    pub(crate) async fn admit_request(
        &self,
        key_id: &str,
        max_requests_per_minute: i64,
        max_requests_per_day: i64,
        now_ms: i64,
    ) -> Result<bool, &'static str> {
        if key_id.is_empty()
            || key_id.len() > 128
            || !(0..=MAX_SAFE_INTEGER).contains(&max_requests_per_minute)
            || !(0..=MAX_SAFE_INTEGER).contains(&max_requests_per_day)
            || (max_requests_per_minute == 0 && max_requests_per_day == 0)
            || !(MIN_USAGE_TIMESTAMP_MS..MAX_USAGE_TIMESTAMP_MS).contains(&now_ms)
        {
            return Err("invalid request rate limit");
        }
        let mut connection = self.begin().await?;
        let result = self
            .admit_request_in(
                &mut connection,
                key_id,
                max_requests_per_minute,
                max_requests_per_day,
                now_ms,
            )
            .await;
        match result {
            Ok(allowed) => {
                sqlx::query("COMMIT")
                    .execute(&mut *connection)
                    .await
                    .map_err(|_| "request rate-limit storage unavailable")?;
                Ok(allowed)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }

    async fn admit_request_in(
        &self,
        connection: &mut PoolConnection<Any>,
        key_id: &str,
        max_requests_per_minute: i64,
        max_requests_per_day: i64,
        now_ms: i64,
    ) -> Result<bool, &'static str> {
        let limits = [
            (60_i64, max_requests_per_minute),
            (86_400_i64, max_requests_per_day),
        ];
        let mut active_windows = [(0_i64, 0_i64, false); 2];
        for (index, (window_seconds, limit)) in limits
            .into_iter()
            .filter(|(_, limit)| *limit > 0)
            .enumerate()
        {
            let window_ms = window_seconds
                .checked_mul(1_000)
                .ok_or("request rate-limit overflow")?;
            let bucket = now_ms / window_ms;
            let counters = sqlx::query("SELECT COALESCE(SUM(CASE WHEN bucket_index = $1 THEN consumed_requests ELSE 0 END),0) AS current_requests, COALESCE(SUM(CASE WHEN bucket_index = $2 THEN consumed_requests ELSE 0 END),0) AS previous_requests FROM redrouter_request_rate_counters WHERE key_id = $3 AND window_seconds = $4 AND bucket_index IN ($1,$2)")
                .bind(bucket)
                .bind(bucket - 1)
                .bind(key_id)
                .bind(window_seconds)
                .fetch_one(&mut **connection)
                .await
                .map_err(|_| "request rate-limit counters unavailable")?;
            let current: i64 = counters
                .try_get("current_requests")
                .map_err(|_| "invalid request rate-limit counter")?;
            let previous: i64 = counters
                .try_get("previous_requests")
                .map_err(|_| "invalid request rate-limit counter")?;
            if current < 0 || previous < 0 {
                return Err("invalid request rate-limit counter");
            }
            let previous_weight = window_ms - now_ms.rem_euclid(window_ms);
            let weighted_previous = previous
                .checked_mul(previous_weight)
                .and_then(|value| value.checked_add(window_ms - 1))
                .map(|value| value / window_ms)
                .ok_or("request rate-limit overflow")?;
            let used = current
                .checked_add(weighted_previous)
                .ok_or("request rate-limit overflow")?;
            if used >= limit {
                return Ok(false);
            }
            active_windows[index] = (window_seconds, bucket, current == 0);
        }
        for (window_seconds, bucket, first_in_bucket) in active_windows
            .into_iter()
            .filter(|(window_seconds, _, _)| *window_seconds > 0)
        {
            sqlx::query("INSERT INTO redrouter_request_rate_counters (key_id,window_seconds,bucket_index,consumed_requests,updated_at_unix_ms) VALUES ($1,$2,$3,1,$4) ON CONFLICT (key_id,window_seconds,bucket_index) DO UPDATE SET consumed_requests = redrouter_request_rate_counters.consumed_requests + 1, updated_at_unix_ms = $4")
                .bind(key_id)
                .bind(window_seconds)
                .bind(bucket)
                .bind(now_ms)
                .execute(&mut **connection)
                .await
                .map_err(|_| "cannot update request rate-limit counter")?;
            if first_in_bucket {
                sqlx::query("DELETE FROM redrouter_request_rate_counters WHERE key_id = $1 AND window_seconds = $2 AND bucket_index < $3")
                    .bind(key_id)
                    .bind(window_seconds)
                    .bind(bucket - 1)
                    .execute(&mut **connection)
                    .await
                    .map_err(|_| "cannot prune request rate-limit counters")?;
            }
        }
        Ok(true)
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
        let mut totals = QueryBuilder::<Any>::new("SELECT COUNT(*) AS request_count, COALESCE(SUM(pricing_known),0) AS priced_request_count, COALESCE(SUM(tokens_input),0) AS tokens_input, COALESCE(SUM(tokens_output),0) AS tokens_output, COALESCE(SUM(tokens_cache_read),0) AS tokens_cache_read, COALESCE(SUM(tokens_cache_creation),0) AS tokens_cache_creation, COALESCE(SUM(tokens_reasoning),0) AS tokens_reasoning, COALESCE(SUM(search_units),0) AS search_units, COALESCE(SUM(amount_microusd),0) AS amount_microusd FROM redrouter_usage_ledger WHERE created_at_unix_ms >= ");
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
        let mut rows = QueryBuilder::<Any>::new("SELECT event_id,key_id,CASE WHEN key_name = '' THEN key_id ELSE key_name END AS key_name,tenant_id,provider,model,usage_kind,search_units,tokens_input,tokens_output,tokens_cache_read,tokens_cache_creation,tokens_reasoning,amount_microusd,pricing_known,pricing_snapshot,created_at_unix_ms FROM redrouter_usage_ledger WHERE created_at_unix_ms >= ");
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
        let optional_json = |row: &sqlx::any::AnyRow, name| {
            row.try_get::<Option<String>, _>(name)
                .map_err(|_| "invalid usage ledger")?
                .map(|value| {
                    serde_json::from_str::<serde_json::Value>(&value)
                        .map_err(|_| "invalid usage ledger")
                })
                .transpose()
        };
        let entries = rows
            .iter()
            .map(|row| {
                let pricing_known = integer(row, "pricing_known")?;
                let pricing_snapshot = optional_json(row, "pricing_snapshot")?;
                if !matches!(pricing_known, 0 | 1)
                    || (pricing_known == 1) != pricing_snapshot.is_some()
                {
                    return Err("invalid usage ledger");
                }
                let usage_kind = text(row, "usage_kind")?;
                let search_units = integer(row, "search_units")?;
                if !matches!(usage_kind.as_str(), "tokens" | "rerank")
                    || search_units < 0
                    || (usage_kind == "tokens" && search_units != 0)
                {
                    return Err("invalid usage ledger");
                }
                Ok(UsageLedgerEntry {
                    event_id: text(row, "event_id")?,
                    key_id: text(row, "key_id")?,
                    key_name: text(row, "key_name")?,
                    tenant_id: text(row, "tenant_id")?,
                    provider: text(row, "provider")?,
                    model: text(row, "model")?,
                    usage_kind,
                    search_units,
                    tokens_input: integer(row, "tokens_input")?,
                    tokens_output: integer(row, "tokens_output")?,
                    tokens_cache_read: integer(row, "tokens_cache_read")?,
                    tokens_cache_creation: integer(row, "tokens_cache_creation")?,
                    tokens_reasoning: integer(row, "tokens_reasoning")?,
                    amount_microusd: integer(row, "amount_microusd")?,
                    pricing_known: pricing_known == 1,
                    pricing_snapshot,
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
            search_units: integer(&totals, "search_units")?,
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
        if !(0..=MAX_SAFE_INTEGER).contains(&reservation.reserved_tokens)
            || !(0..=MAX_SAFE_INTEGER).contains(&reservation.reserved_microusd)
            || (quota.max_tokens_per_minute > 0
                && reservation.reserved_tokens > quota.max_tokens_per_minute)
            || (quota.max_tokens_per_day > 0
                && reservation.reserved_tokens > quota.max_tokens_per_day)
            || (quota.max_monthly_microusd > 0
                && (reservation.reserved_microusd == 0
                    || reservation.reserved_microusd > quota.max_monthly_microusd))
        {
            return Err("invalid usage reservation bounds");
        }
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
        // The legacy daily quota counts input + output. Reasoning is already a
        // detail of output, while the separate TPM policy deliberately retains
        // its existing product-specific accounting formula.
        let ledger = sqlx::query("SELECT COALESCE(SUM(CASE WHEN created_at_unix_ms >= $1 THEN tokens_input + tokens_output ELSE 0 END),0) AS daily_tokens, COALESCE(SUM(CASE WHEN created_at_unix_ms >= $2 THEN amount_microusd ELSE 0 END),0) AS monthly_microusd FROM redrouter_usage_ledger WHERE key_id = $3")
            .bind(day_start)
            .bind(month_start)
            .bind(reservation.key_id)
            .fetch_one(&mut **connection)
            .await
            .map_err(|_| "usage ledger unavailable")?;
        let mut used_day: i64 = ledger
            .try_get("daily_tokens")
            .map_err(|_| "invalid usage ledger")?;
        let mut used_month: i64 = ledger
            .try_get("monthly_microusd")
            .map_err(|_| "invalid usage ledger")?;
        if let Some(baseline) = sqlx::query("SELECT tenant_id,day_start_unix_ms,daily_tokens,month_start_unix_ms,monthly_microusd FROM redrouter_legacy_quota_baselines WHERE key_id = $1")
            .bind(reservation.key_id)
            .fetch_optional(&mut **connection)
            .await
            .map_err(|_| "legacy quota baseline unavailable")?
        {
            let tenant: String = baseline.try_get("tenant_id").map_err(|_| "invalid legacy quota baseline")?;
            let legacy_day: i64 = baseline.try_get("day_start_unix_ms").map_err(|_| "invalid legacy quota baseline")?;
            let daily: i64 = baseline.try_get("daily_tokens").map_err(|_| "invalid legacy quota baseline")?;
            let legacy_month: i64 = baseline.try_get("month_start_unix_ms").map_err(|_| "invalid legacy quota baseline")?;
            let monthly: i64 = baseline.try_get("monthly_microusd").map_err(|_| "invalid legacy quota baseline")?;
            if tenant != reservation.tenant_id || daily < 0 || monthly < 0 || legacy_day > day_start || legacy_month > month_start {
                return Err("invalid legacy quota baseline");
            }
            if legacy_day == day_start { used_day = used_day.checked_add(daily).ok_or("usage counter overflow")?; }
            if legacy_month == month_start { used_month = used_month.checked_add(monthly).ok_or("usage counter overflow")?; }
        }
        let token_total = |used: i64| {
            used.checked_add(pending_tokens)
                .and_then(|value| value.checked_add(reservation.reserved_tokens))
        };
        let spend_total = used_month
            .checked_add(pending_microusd)
            .and_then(|value| value.checked_add(reservation.reserved_microusd));
        let denied = (quota.max_tokens_per_minute > 0
            && token_total(used_minute).is_none_or(|value| value > quota.max_tokens_per_minute))
            || (quota.max_tokens_per_day > 0
                && token_total(used_day).is_none_or(|value| value > quota.max_tokens_per_day))
            || (quota.max_monthly_microusd > 0
                && spend_total.is_none_or(|value| value > quota.max_monthly_microusd));
        if denied {
            return Ok(false);
        }
        // Each matching model window is checked while the same SQLite write
        // lock protects both the completed ledger and all outstanding holds.
        let model_limits = sqlx::query("SELECT reset_interval,reset_minutes,token_limit FROM redrouter_client_model_token_limits WHERE key_id=$1 AND model=$2")
            .bind(reservation.key_id).bind(reservation.model).fetch_all(&mut **connection)
            .await.map_err(|_| "model quota unavailable")?;
        for limit in model_limits {
            let interval: String = limit
                .try_get("reset_interval")
                .map_err(|_| "invalid model quota")?;
            let reset: i64 = limit
                .try_get("reset_minutes")
                .map_err(|_| "invalid model quota")?;
            let maximum: i64 = limit
                .try_get("token_limit")
                .map_err(|_| "invalid model quota")?;
            if !(1..=MAX_SAFE_INTEGER).contains(&maximum) {
                return Err("invalid model quota");
            }
            let window = model_window_start(reservation.now_ms, &interval, reset)?;
            let consumed: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(tokens_input + tokens_output + tokens_reasoning),0) FROM redrouter_usage_ledger WHERE key_id=$1 AND model=$2 AND created_at_unix_ms >= $3")
                .bind(reservation.key_id).bind(reservation.model).bind(window).fetch_one(&mut **connection)
                .await.map_err(|_| "model quota ledger unavailable")?;
            let held: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(reserved_tokens),0) FROM redrouter_usage_reservations WHERE key_id=$1 AND model=$2")
                .bind(reservation.key_id).bind(reservation.model).fetch_one(&mut **connection)
                .await.map_err(|_| "model quota reservations unavailable")?;
            if consumed < 0 || held < 0 {
                return Err("invalid model quota state");
            }
            if consumed
                .checked_add(held)
                .and_then(|n| n.checked_add(reservation.reserved_tokens))
                .is_none_or(|n| n > maximum)
            {
                return Ok(false);
            }
        }
        let inserted = sqlx::query("INSERT INTO redrouter_usage_reservations (event_id,key_id,tenant_id,provider,model,reserved_tokens,reserved_microusd,created_at_unix_ms,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'dispatched') ON CONFLICT (event_id) DO NOTHING")
            .bind(reservation.event_id)
            .bind(reservation.key_id)
            .bind(reservation.tenant_id)
            .bind(reservation.provider)
            .bind(reservation.model)
            .bind(reservation.reserved_tokens)
            .bind(reservation.reserved_microusd)
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
        if event.key_name.is_empty() || event.key_name.len() > 256 {
            return Err("invalid usage event");
        }
        validate_route(event.provider, event.model)?;
        if !(MIN_USAGE_TIMESTAMP_MS..MAX_USAGE_TIMESTAMP_MS).contains(&event.now_ms) {
            return Err("invalid usage event");
        }
        let tokens = match event.kind {
            UsageKind::Tokens => {
                if event.search_units != 0 || event.rerank_price.is_some() {
                    return Err("invalid token usage event");
                }
                i64::try_from(event.usage.billable_tokens()?).map_err(|_| "invalid token usage")?
            }
            UsageKind::Rerank => {
                if event.usage.billable_tokens()? != 0 || event.prices.is_some() {
                    return Err("invalid rerank usage event");
                }
                0
            }
        };
        let search_units = i64::try_from(event.search_units).map_err(|_| "invalid rerank usage")?;
        let amount_microusd = match (event.kind, event.prices, event.rerank_price) {
            (UsageKind::Tokens, Some(prices), None) => {
                usd_to_micros(prices.cost_usd(event.usage)?)?
            }
            (UsageKind::Rerank, None, Some(price)) => {
                if !price.per_search_unit.is_finite() || price.per_search_unit < 0.0 {
                    return Err("invalid rerank price");
                }
                usd_to_micros(price.per_search_unit * event.search_units as f64)?
            }
            (UsageKind::Tokens, None, None) | (UsageKind::Rerank, None, None) => 0,
            _ => return Err("invalid usage pricing"),
        };
        let pricing_snapshot =
            native_pricing_snapshot(event.kind, event.prices, event.rerank_price, event.now_ms)?;
        let mut connection = self.begin().await?;
        let result = self
            .settle_in(
                &mut connection,
                event,
                tokens,
                search_units,
                amount_microusd,
                pricing_snapshot.as_deref(),
            )
            .await;
        match result {
            Ok(recorded) => {
                sqlx::query("COMMIT")
                    .execute(&mut *connection)
                    .await
                    .map_err(|_| "usage storage unavailable")?;
                Ok(recorded)
            }
            Err("usage exceeds reservation; reconciliation required") => {
                // Persist the quarantine before returning an error. Rolling
                // this transaction back would leave the underestimated hold
                // available for further admissions.
                sqlx::query("COMMIT")
                    .execute(&mut *connection)
                    .await
                    .map_err(|_| "usage storage unavailable")?;
                Err("usage exceeds reservation; reconciliation required")
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
        search_units: i64,
        amount_microusd: i64,
        pricing_snapshot: Option<&str>,
    ) -> Result<bool, &'static str> {
        if !event.reserved {
            let exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM redrouter_usage_ledger WHERE event_id = $1",
            )
            .bind(event.event_id)
            .fetch_one(&mut **connection)
            .await
            .map_err(|_| "usage ledger unavailable")?;
            if exists == 1 {
                return Ok(false);
            }
        } else {
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
            if tokens > reserved_tokens
                || (reserved_microusd > 0 && amount_microusd > reserved_microusd)
            {
                sqlx::query("UPDATE redrouter_usage_reservations SET reserved_tokens = $2, reserved_microusd = $2 WHERE event_id = $1")
                    .bind(event.event_id)
                    .bind(MAX_SAFE_INTEGER)
                    .execute(&mut **connection)
                    .await
                    .map_err(|_| "usage reservation unavailable")?;
                return Err("usage exceeds reservation; reconciliation required");
            }
        }
        let input = i64::try_from(event.usage.input).map_err(|_| "invalid token usage")?;
        let output = i64::try_from(event.usage.output).map_err(|_| "invalid token usage")?;
        let cache_read =
            i64::try_from(event.usage.cache_read).map_err(|_| "invalid token usage")?;
        let cache_creation =
            i64::try_from(event.usage.cache_creation).map_err(|_| "invalid token usage")?;
        let reasoning = i64::try_from(event.usage.reasoning).map_err(|_| "invalid token usage")?;
        sqlx::query("INSERT INTO redrouter_usage_ledger (event_id,key_id,key_name,tenant_id,provider,model,usage_kind,search_units,tokens_input,tokens_output,tokens_cache_read,tokens_cache_creation,tokens_reasoning,amount_microusd,pricing_known,pricing_snapshot,created_at_unix_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)")
            .bind(event.event_id)
            .bind(event.key_id)
            .bind(event.key_name)
            .bind(event.tenant_id)
            .bind(event.provider)
            .bind(event.model)
            .bind(event.kind.as_str())
            .bind(search_units)
            .bind(input)
            .bind(output)
            .bind(cache_read)
            .bind(cache_creation)
            .bind(reasoning)
            .bind(amount_microusd)
            .bind(i64::from(event.prices.is_some() || event.rerank_price.is_some()))
            .bind(pricing_snapshot)
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
        if event.reserved {
            sqlx::query("DELETE FROM redrouter_usage_reservations WHERE event_id = $1")
                .bind(event.event_id)
                .execute(&mut **connection)
                .await
                .map_err(|_| "cannot settle usage reservation")?;
        }
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

pub(crate) fn model_window_start(
    now_ms: i64,
    interval: &str,
    reset_minutes: i64,
) -> Result<i64, &'static str> {
    if !(0..1440).contains(&reset_minutes) {
        return Err("invalid model quota reset");
    }
    let now = OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms) * 1_000_000)
        .map_err(|_| "invalid model quota timestamp")?;
    let reset = time::Time::from_hms((reset_minutes / 60) as u8, (reset_minutes % 60) as u8, 0)
        .map_err(|_| "invalid model quota reset")?;
    let today = now.date();
    let date = match interval {
        "daily" => today,
        "weekly" => today
            .checked_sub(time::Duration::days(i64::from(
                today.weekday().number_days_from_monday(),
            )))
            .ok_or("invalid model quota timestamp")?,
        "monthly" => time::Date::from_calendar_date(today.year(), today.month(), 1)
            .map_err(|_| "invalid model quota timestamp")?,
        _ => return Err("invalid model quota interval"),
    };
    let candidate = date.with_time(reset).assume_utc();
    let start = if candidate <= now {
        candidate
    } else {
        let prior = match interval {
            "daily" => date.checked_sub(time::Duration::days(1)),
            "weekly" => date.checked_sub(time::Duration::days(7)),
            "monthly" => date
                .previous_day()
                .and_then(|day| time::Date::from_calendar_date(day.year(), day.month(), 1).ok()),
            _ => None,
        }
        .ok_or("invalid model quota timestamp")?;
        prior.with_time(reset).assume_utc()
    };
    i64::try_from(start.unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| "invalid model quota timestamp")
}

fn usd_to_micros(usd: f64) -> Result<i64, &'static str> {
    let micros = usd * 1_000_000.0;
    if !micros.is_finite() || micros < 0.0 || micros > MAX_SAFE_INTEGER as f64 {
        return Err("invalid usage cost");
    }
    Ok(micros.ceil() as i64)
}

fn native_pricing_snapshot(
    kind: UsageKind,
    prices: Option<&TokenPrices>,
    rerank_price: Option<&RerankPrice>,
    captured_at_unix_ms: i64,
) -> Result<Option<String>, &'static str> {
    if !(MIN_USAGE_TIMESTAMP_MS..MAX_USAGE_TIMESTAMP_MS).contains(&captured_at_unix_ms) {
        return Err("invalid usage price snapshot");
    }
    let snapshot = match (kind, prices, rerank_price) {
        (UsageKind::Tokens, Some(prices), None) => {
            if [
                prices.input,
                prices.output,
                prices.cache_read,
                prices.cache_creation,
                prices.reasoning,
            ]
            .into_iter()
            .any(|price| !price.is_finite() || price < 0.0)
            {
                return Err("invalid usage price snapshot");
            }
            serde_json::json!({
                "currency": "USD",
                "unit": "million-tokens",
                "source": "models.dev",
                "capturedAtUnixMs": captured_at_unix_ms,
                "input": prices.input,
                "output": prices.output,
                "cacheRead": prices.cache_read,
                "cacheWrite": prices.cache_creation,
                "reasoning": prices.reasoning,
            })
        }
        (UsageKind::Rerank, None, Some(price)) => {
            if !price.per_search_unit.is_finite() || price.per_search_unit < 0.0 {
                return Err("invalid usage price snapshot");
            }
            serde_json::json!({
                "currency": "USD",
                "unit": "search-unit",
                "source": price.source,
                "capturedAtUnixMs": captured_at_unix_ms,
                "searchUnit": price.per_search_unit,
            })
        }
        (UsageKind::Tokens, None, None) | (UsageKind::Rerank, None, None) => return Ok(None),
        _ => return Err("invalid usage price snapshot"),
    };
    serde_json::to_string(&snapshot)
        .map(Some)
        .map_err(|_| "invalid usage price snapshot")
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

    #[test]
    fn model_windows_follow_utc_reset_boundaries() {
        use time::format_description::well_known::Rfc3339;
        let ms = |value: &str| {
            OffsetDateTime::parse(value, &Rfc3339)
                .unwrap()
                .unix_timestamp()
                * 1000
        };
        assert_eq!(
            model_window_start(ms("2024-03-01T01:00:00Z"), "monthly", 120).unwrap(),
            ms("2024-02-01T02:00:00Z")
        );
        assert_eq!(
            model_window_start(ms("2024-03-04T01:00:00Z"), "weekly", 120).unwrap(),
            ms("2024-02-26T02:00:00Z")
        );
        assert_eq!(
            model_window_start(ms("2024-03-04T02:00:00Z"), "daily", 120).unwrap(),
            ms("2024-03-04T02:00:00Z")
        );
        assert!(model_window_start(ms("2024-03-04T02:00:00Z"), "hourly", 0).is_err());
    }

    #[tokio::test]
    async fn model_limit_serializes_reservations_across_instances() {
        let folder = TempDir::new().unwrap();
        let url = sqlite_url(&folder);
        let first = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        sqlx::query("INSERT INTO redrouter_client_model_token_limits VALUES ('key','limited','daily',0,100)")
            .execute(first.sql_pool().unwrap()).await.unwrap();
        let second = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        let one = NativeUsage::new(first.clone()).unwrap();
        let two = NativeUsage::new(second).unwrap();
        let global = NativeQuota {
            max_tokens_per_minute: 1000,
            max_tokens_per_day: 1000,
            max_monthly_microusd: 0,
            reservation_tokens: 60,
            reservation_microusd: 0,
        };
        let reservation = Reservation {
            event_id: "one",
            key_id: "key",
            tenant_id: "tenant",
            provider: "openai",
            model: "limited",
            quota: global,
            reserved_tokens: 60,
            reserved_microusd: 0,
            now_ms: 1_700_000_000_000,
        };
        let other = Reservation {
            event_id: "two",
            ..reservation
        };
        let (a, b) = tokio::join!(one.reserve(&reservation), two.reserve(&other));
        assert_ne!(a.unwrap(), b.unwrap());
        let different = Reservation {
            event_id: "different",
            model: "another-model",
            ..reservation
        };
        assert!(one.reserve(&different).await.unwrap());
    }

    #[tokio::test]
    async fn migrated_baseline_and_pending_reservations_reduce_available_quota() {
        let folder = TempDir::new().unwrap();
        let database = Arc::new(
            Database::connect(Backend::Sqlite, &sqlite_url(&folder))
                .await
                .unwrap(),
        );
        let pool = database.sql_pool().unwrap();
        let now = 1_700_000_000_000;
        let (day, month) = boundaries(now).unwrap();
        sqlx::query(
            "INSERT INTO redrouter_legacy_quota_baselines VALUES ('key','tenant',$1,900,$2,800000)",
        )
        .bind(day)
        .bind(month)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO redrouter_usage_reservations VALUES ('old','key','tenant','legacy','unknown',50,150000,$1,'dispatched')")
            .bind(now).execute(pool).await.unwrap();
        let usage = NativeUsage::new(database).unwrap();
        let reservation = Reservation {
            event_id: "new",
            key_id: "key",
            tenant_id: "tenant",
            provider: "openai",
            model: "gpt",
            quota: NativeQuota {
                max_tokens_per_minute: 0,
                max_monthly_microusd: 0,
                reservation_microusd: 0,
                ..quota()
            },
            reserved_tokens: 60,
            reserved_microusd: 0,
            now_ms: now,
        };
        assert!(!usage.reserve(&reservation).await.unwrap());
        let monthly = Reservation {
            event_id: "monthly",
            quota: NativeQuota {
                max_tokens_per_minute: 0,
                max_tokens_per_day: 0,
                ..quota()
            },
            reserved_microusd: 100_000,
            ..reservation
        };
        assert!(!usage.reserve(&monthly).await.unwrap());
        let other = Reservation {
            tenant_id: "other",
            ..monthly
        };
        assert!(usage.reserve(&other).await.is_err());
        let next_day = day + 86_400_000;
        let expired = Reservation {
            event_id: "next",
            key_id: "key",
            tenant_id: "tenant",
            provider: "openai",
            model: "gpt",
            quota: NativeQuota {
                max_tokens_per_minute: 0,
                max_monthly_microusd: 0,
                reservation_microusd: 0,
                ..quota()
            },
            reserved_tokens: 60,
            reserved_microusd: 0,
            now_ms: next_day,
        };
        assert!(
            usage.reserve(&expired).await.unwrap(),
            "the daily baseline must expire but the existing hold remains"
        );
    }

    #[tokio::test]
    async fn daily_quota_does_not_count_reasoning_twice() {
        let folder = TempDir::new().unwrap();
        let database = Arc::new(
            Database::connect(Backend::Sqlite, &sqlite_url(&folder))
                .await
                .unwrap(),
        );
        let pool = database.sql_pool().unwrap();
        let now = 1_700_000_000_000;
        sqlx::query("INSERT INTO redrouter_usage_ledger (event_id,key_id,key_name,tenant_id,provider,model,tokens_input,tokens_output,tokens_cache_read,tokens_cache_creation,tokens_reasoning,amount_microusd,pricing_known,pricing_snapshot,created_at_unix_ms) VALUES ('old','key','Key','tenant','openai','gpt',10,10,0,0,10,0,0,NULL,$1)")
            .bind(now).execute(pool).await.unwrap();
        let usage = NativeUsage::new(database).unwrap();
        let quota = NativeQuota {
            max_tokens_per_minute: 0,
            max_tokens_per_day: 30,
            max_monthly_microusd: 0,
            reservation_tokens: 10,
            reservation_microusd: 0,
        };
        assert!(usage
            .reserve(&Reservation {
                event_id: "new",
                key_id: "key",
                tenant_id: "tenant",
                provider: "openai",
                model: "gpt",
                quota,
                reserved_tokens: 10,
                reserved_microusd: 0,
                now_ms: now
            })
            .await
            .unwrap());
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
                            reserved_tokens: 60,
                            reserved_microusd: 100_000,
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
    async fn independent_proxies_share_atomic_request_rate_limits() {
        let folder = TempDir::new().unwrap();
        let url = sqlite_url(&folder);
        let first = NativeUsage::new(Arc::new(
            Database::connect(Backend::Sqlite, &url).await.unwrap(),
        ))
        .unwrap();
        let second = NativeUsage::new(Arc::new(
            Database::connect(Backend::Sqlite, &url).await.unwrap(),
        ))
        .unwrap();
        let tasks = (0..16)
            .map(|index| {
                let usage = if index % 2 == 0 {
                    first.clone()
                } else {
                    second.clone()
                };
                tokio::spawn(async move {
                    usage
                        .admit_request("shared-key", 4, 0, 1_700_000_030_000)
                        .await
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let mut admitted = 0;
        for task in tasks {
            admitted += usize::from(task.await.unwrap());
        }
        assert_eq!(admitted, 4);
    }

    #[tokio::test]
    async fn request_rate_limits_enforce_minute_and_day_windows() {
        let folder = TempDir::new().unwrap();
        let database = Arc::new(
            Database::connect(Backend::Sqlite, &sqlite_url(&folder))
                .await
                .unwrap(),
        );
        let usage = NativeUsage::new(database).unwrap();
        let now = 1_700_000_030_000;
        assert!(usage.admit_request("minute-key", 2, 0, now).await.unwrap());
        assert!(usage.admit_request("minute-key", 2, 0, now).await.unwrap());
        assert!(!usage.admit_request("minute-key", 2, 0, now).await.unwrap());

        assert!(usage.admit_request("day-key", 0, 2, now).await.unwrap());
        assert!(usage.admit_request("day-key", 0, 2, now).await.unwrap());
        assert!(!usage.admit_request("day-key", 0, 2, now).await.unwrap());
    }

    #[tokio::test]
    async fn maintenance_prunes_only_expired_operational_counters_in_batches() {
        let folder = TempDir::new().unwrap();
        let database = Arc::new(
            Database::connect(Backend::Sqlite, &sqlite_url(&folder))
                .await
                .unwrap(),
        );
        let usage = NativeUsage::new(database.clone()).unwrap();
        let now = 1_700_000_030_000_i64;
        let minute = now / 60_000;
        let day = now / 86_400_000;
        for bucket in [minute, minute - 1, minute - 2, minute - 3, minute - 4] {
            sqlx::query("INSERT INTO redrouter_usage_counters (key_id,minute_bucket,consumed_tokens,updated_at_unix_ms) VALUES ('key',$1,1,$2)")
                .bind(bucket)
                .bind(now)
                .execute(database.sql_pool().unwrap())
                .await
                .unwrap();
        }
        for (window, bucket) in [
            (60_i64, minute),
            (60, minute - 1),
            (60, minute - 2),
            (86_400, day),
            (86_400, day - 1),
            (86_400, day - 2),
            (1, 0),
        ] {
            sqlx::query("INSERT INTO redrouter_request_rate_counters (key_id,window_seconds,bucket_index,consumed_requests,updated_at_unix_ms) VALUES ('key',$1,$2,1,$3)")
                .bind(window)
                .bind(bucket)
                .bind(now)
                .execute(database.sql_pool().unwrap())
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO redrouter_usage_ledger (event_id,key_id,key_name,tenant_id,provider,model,tokens_input,tokens_output,tokens_cache_read,tokens_cache_creation,tokens_reasoning,amount_microusd,pricing_known,pricing_snapshot,created_at_unix_ms) VALUES ('historical','key','Key','red','openai','gpt',1,1,0,0,0,0,0,NULL,$1)")
            .bind(now - 10 * 86_400_000)
            .execute(database.sql_pool().unwrap())
            .await
            .unwrap();
        sqlx::query("INSERT INTO redrouter_usage_reservations (event_id,key_id,tenant_id,provider,model,reserved_tokens,reserved_microusd,created_at_unix_ms,state) VALUES ('uncertain','key','red','openai','gpt',10,0,$1,'dispatched')")
            .bind(now - 10 * 86_400_000)
            .execute(database.sql_pool().unwrap())
            .await
            .unwrap();

        let first = usage.prune_operational_state(now, 2).await.unwrap();
        assert_eq!(first.usage_counters_deleted, 2);
        assert_eq!(first.request_counters_deleted, 2);
        assert!(first.has_more);
        let second = usage.prune_operational_state(now, 2).await.unwrap();
        assert_eq!(second.usage_counters_deleted, 1);
        assert_eq!(second.request_counters_deleted, 1);
        assert!(!second.has_more);

        let usage_buckets: Vec<i64> = sqlx::query_scalar(
            "SELECT minute_bucket FROM redrouter_usage_counters ORDER BY minute_bucket",
        )
        .fetch_all(database.sql_pool().unwrap())
        .await
        .unwrap();
        assert_eq!(usage_buckets, vec![minute - 1, minute]);
        let request_rows: Vec<(i64, i64)> = sqlx::query_as("SELECT window_seconds,bucket_index FROM redrouter_request_rate_counters ORDER BY window_seconds,bucket_index")
            .fetch_all(database.sql_pool().unwrap())
            .await
            .unwrap();
        assert_eq!(
            request_rows,
            vec![
                (60, minute - 1),
                (60, minute),
                (86_400, day - 1),
                (86_400, day)
            ]
        );
        let ledger_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_usage_ledger")
            .fetch_one(database.sql_pool().unwrap())
            .await
            .unwrap();
        let reservations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_usage_reservations")
                .fetch_one(database.sql_pool().unwrap())
                .await
                .unwrap();
        assert_eq!((ledger_rows, reservations), (1, 1));
    }

    #[tokio::test]
    async fn rerank_reservations_do_not_consume_token_headroom() {
        let folder = TempDir::new().unwrap();
        let database = Arc::new(
            Database::connect(Backend::Sqlite, &sqlite_url(&folder))
                .await
                .unwrap(),
        );
        let usage = NativeUsage::new(database).unwrap();
        let token_quota = NativeQuota {
            max_tokens_per_minute: 60,
            max_tokens_per_day: 60,
            max_monthly_microusd: 0,
            reservation_tokens: 60,
            reservation_microusd: 0,
        };
        assert!(usage
            .reserve(&Reservation {
                event_id: "rerank-reservation",
                key_id: "key",
                tenant_id: "tenant",
                provider: "cohere",
                model: "rerank-v3.5",
                quota: token_quota,
                reserved_tokens: 0,
                reserved_microusd: 0,
                now_ms: 1_700_000_000_000,
            })
            .await
            .unwrap());
        assert!(usage
            .reserve(&Reservation {
                event_id: "token-reservation",
                key_id: "key",
                tenant_id: "tenant",
                provider: "openai",
                model: "gpt-4.1",
                quota: token_quota,
                reserved_tokens: 60,
                reserved_microusd: 0,
                now_ms: 1_700_000_000_000,
            })
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn underestimated_reservation_stays_quarantined_after_restart() {
        let folder = TempDir::new().unwrap();
        let url = sqlite_url(&folder);
        let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        let usage = NativeUsage::new(database.clone()).unwrap();
        let reservation = Reservation {
            event_id: "underestimated",
            key_id: "key",
            tenant_id: "tenant",
            provider: "openai",
            model: "gpt",
            quota: quota(),
            reserved_tokens: 60,
            reserved_microusd: 100_000,
            now_ms: 1_700_000_000_000,
        };
        assert!(usage.reserve(&reservation).await.unwrap());
        let tokens = ChatUsage {
            input: 61,
            output: 0,
            reasoning: 0,
            cache_read: 0,
            cache_creation: 0,
        };
        let event = UsageEvent {
            event_id: reservation.event_id,
            key_id: reservation.key_id,
            key_name: "Agent",
            tenant_id: reservation.tenant_id,
            provider: reservation.provider,
            model: reservation.model,
            usage: &tokens,
            prices: None,
            kind: UsageKind::Tokens,
            search_units: 0,
            rerank_price: None,
            now_ms: reservation.now_ms,
            reserved: true,
        };
        assert_eq!(
            usage.settle(&event).await,
            Err("usage exceeds reservation; reconciliation required")
        );
        drop(usage);
        Arc::try_unwrap(database)
            .ok()
            .unwrap()
            .close()
            .await
            .unwrap();
        let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        let hold: (i64, i64) = sqlx::query_as("SELECT reserved_tokens,reserved_microusd FROM redrouter_usage_reservations WHERE event_id='underestimated'")
            .fetch_one(database.sql_pool().unwrap()).await.unwrap();
        assert_eq!(hold, (MAX_SAFE_INTEGER, MAX_SAFE_INTEGER));
        let usage = NativeUsage::new(database).unwrap();
        let next = Reservation {
            event_id: "next",
            ..reservation
        };
        assert!(!usage.reserve(&next).await.unwrap());
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
                reserved_tokens: 60,
                reserved_microusd: 100_000,
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
                key_name: "Agent fleet",
                tenant_id: "tenant",
                provider: "openai",
                model: "gpt-4.1",
                usage: &tokens,
                prices: Some(&prices),
                kind: UsageKind::Tokens,
                search_units: 0,
                rerank_price: None,
                now_ms: 1_700_000_000_100,
                reserved: true,
            })
            .await
            .unwrap());
        let ledger: (i64, i64, String) = sqlx::query_as(
            "SELECT tokens_input + tokens_output + tokens_reasoning, amount_microusd, pricing_snapshot FROM redrouter_usage_ledger WHERE event_id = 'event-one'",
        )
        .fetch_one(database.sql_pool().unwrap())
        .await
        .unwrap();
        assert_eq!((ledger.0, ledger.1), (17, 40));
        let snapshot: serde_json::Value = serde_json::from_str(&ledger.2).unwrap();
        assert_eq!(snapshot["source"], "models.dev");
        assert_eq!(snapshot["capturedAtUnixMs"], 1_700_000_000_100_i64);
        assert_eq!(snapshot["input"], 2.0);
        assert_eq!(snapshot["output"], 4.0);
        assert_eq!(snapshot["cacheRead"], 1.0);
        assert_eq!(snapshot["cacheWrite"], 2.0);
        assert_eq!(snapshot["reasoning"], 4.0);
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
                reserved_tokens: 60,
                reserved_microusd: 100_000,
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
                reserved_tokens: 60,
                reserved_microusd: 100_000,
                now_ms: 1_700_000_000_300,
            })
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn unreserved_reporting_records_key_name_without_admission_state() {
        let folder = TempDir::new().unwrap();
        let database = Arc::new(
            Database::connect(Backend::Sqlite, &sqlite_url(&folder))
                .await
                .unwrap(),
        );
        let usage = NativeUsage::new(database.clone()).unwrap();
        let tokens = ChatUsage {
            input: 11,
            output: 7,
            reasoning: 2,
            cache_read: 3,
            cache_creation: 0,
        };
        assert!(usage
            .settle(&UsageEvent {
                event_id: "reported-only",
                key_id: "agent-key",
                key_name: "Agent fleet",
                tenant_id: "tenant",
                provider: "openrouter",
                model: "openai/gpt-5",
                usage: &tokens,
                prices: None,
                kind: UsageKind::Tokens,
                search_units: 0,
                rerank_price: None,
                now_ms: 1_700_000_000_100,
                reserved: false,
            })
            .await
            .unwrap());
        let row: (String, i64, i64) = sqlx::query_as(
            "SELECT key_name,tokens_input,tokens_output FROM redrouter_usage_ledger WHERE event_id='reported-only'",
        )
        .fetch_one(database.sql_pool().unwrap())
        .await
        .unwrap();
        assert_eq!(row, ("Agent fleet".to_owned(), 11, 7));
        let reservations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_usage_reservations")
                .fetch_one(database.sql_pool().unwrap())
                .await
                .unwrap();
        assert_eq!(reservations, 0);
    }

    #[tokio::test]
    async fn token_only_quota_records_known_spend_without_enforcing_a_zero_spend_cap() {
        let folder = TempDir::new().unwrap();
        let database = Arc::new(
            Database::connect(Backend::Sqlite, &sqlite_url(&folder))
                .await
                .unwrap(),
        );
        let usage = NativeUsage::new(database.clone()).unwrap();
        let token_only = NativeQuota {
            max_tokens_per_minute: 100,
            max_tokens_per_day: 1_000,
            max_monthly_microusd: 0,
            reservation_tokens: 60,
            reservation_microusd: 0,
        };
        assert!(usage
            .reserve(&Reservation {
                event_id: "token-only",
                key_id: "key",
                tenant_id: "tenant",
                provider: "openai",
                model: "text-embedding-3-small",
                quota: token_only,
                reserved_tokens: 60,
                reserved_microusd: 0,
                now_ms: 1_700_000_000_000,
            })
            .await
            .unwrap());
        let tokens = ChatUsage {
            input: 4,
            output: 0,
            reasoning: 0,
            cache_read: 0,
            cache_creation: 0,
        };
        let prices = TokenPrices {
            input: 20.0,
            output: 0.0,
            cache_read: 0.0,
            cache_creation: 0.0,
            reasoning: 0.0,
        };
        assert!(usage
            .settle(&UsageEvent {
                event_id: "token-only",
                key_id: "key",
                key_name: "Embedding client",
                tenant_id: "tenant",
                provider: "openai",
                model: "text-embedding-3-small",
                usage: &tokens,
                prices: Some(&prices),
                kind: UsageKind::Tokens,
                search_units: 0,
                rerank_price: None,
                now_ms: 1_700_000_000_100,
                reserved: true,
            })
            .await
            .unwrap());
        let ledger: (i64, i64) = sqlx::query_as(
            "SELECT tokens_input, amount_microusd FROM redrouter_usage_ledger WHERE event_id = 'token-only'",
        )
        .fetch_one(database.sql_pool().unwrap())
        .await
        .unwrap();
        assert_eq!(ledger, (4, 80));
    }

    #[tokio::test]
    async fn rerank_usage_preserves_search_units_without_fabricating_tokens() {
        let folder = TempDir::new().unwrap();
        let database = Arc::new(
            Database::connect(Backend::Sqlite, &sqlite_url(&folder))
                .await
                .unwrap(),
        );
        let usage = NativeUsage::new(database.clone()).unwrap();
        let zero = ChatUsage {
            input: 0,
            output: 0,
            reasoning: 0,
            cache_read: 0,
            cache_creation: 0,
        };
        let price = RerankPrice {
            per_search_unit: 0.002,
            source: "dashboard-user",
        };
        assert!(usage
            .settle(&UsageEvent {
                event_id: "rerank-one",
                key_id: "agent-key",
                key_name: "Retrieval fleet",
                tenant_id: "tenant",
                provider: "cohere",
                model: "rerank-v3.5",
                usage: &zero,
                prices: None,
                kind: UsageKind::Rerank,
                search_units: 3,
                rerank_price: Some(&price),
                now_ms: 1_700_000_000_100,
                reserved: false,
            })
            .await
            .unwrap());
        let row: (String, i64, i64, i64, String) = sqlx::query_as("SELECT usage_kind,search_units,tokens_input + tokens_output + tokens_reasoning,amount_microusd,pricing_snapshot FROM redrouter_usage_ledger WHERE event_id='rerank-one'")
            .fetch_one(database.sql_pool().unwrap())
            .await
            .unwrap();
        assert_eq!(
            (row.0.as_str(), row.1, row.2, row.3),
            ("rerank", 3, 0, 6_000)
        );
        let snapshot: serde_json::Value = serde_json::from_str(&row.4).unwrap();
        assert_eq!(snapshot["unit"], "search-unit");
        assert_eq!(snapshot["source"], "dashboard-user");
        assert_eq!(snapshot["searchUnit"], 0.002);
    }
}
