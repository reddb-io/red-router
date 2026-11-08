//! Strict usage normalization, pricing, and atomic completed-usage recording.
//! These primitives are not connected to request admission or response handling.
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatUsage {
    pub input: u64,
    pub output: u64,
    pub reasoning: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

impl ChatUsage {
    /// Parse a completed OpenAI-compatible response. Missing or inconsistent
    /// accounting must not be interpreted as free usage.
    pub fn from_response(response: &Value) -> Result<Self, &'static str> {
        let usage = response
            .get("usage")
            .and_then(Value::as_object)
            .ok_or("usage is missing")?;
        let required = |field: &str| {
            usage
                .get(field)
                .and_then(Value::as_u64)
                .ok_or("invalid token usage")
        };
        let input = required("prompt_tokens")?;
        let output = required("completion_tokens")?;
        let prompt_details = usage.get("prompt_tokens_details").filter(|v| !v.is_null());
        let output_details = usage
            .get("completion_tokens_details")
            .filter(|v| !v.is_null());
        if prompt_details.is_some_and(|v| !v.is_object())
            || output_details.is_some_and(|v| !v.is_object())
        {
            return Err("invalid token details");
        }
        let optional = |value: Option<&Value>| match value {
            None | Some(Value::Null) => Ok(0),
            Some(value) => value.as_u64().ok_or("invalid token details"),
        };
        let cache_read = optional(prompt_details.and_then(|v| v.get("cached_tokens")))?;
        let cache_creation = optional(prompt_details.and_then(|v| {
            v.get("cache_creation_tokens")
                .or_else(|| v.get("cache_write_tokens"))
        }))?;
        let reasoning = optional(output_details.and_then(|v| v.get("reasoning_tokens")))?;
        if cache_read
            .checked_add(cache_creation)
            .is_none_or(|n| n > input)
            || reasoning > output
        {
            return Err("inconsistent token details");
        }
        let result = Self {
            input,
            output,
            reasoning,
            cache_read,
            cache_creation,
        };
        result.billable_tokens()?;
        Ok(result)
    }

    /// Normalize OpenAI-compatible embedding usage. Providers commonly return
    /// either `prompt_tokens`, `total_tokens`, or both; when both exist they
    /// must agree because embeddings have no completion token dimension.
    pub fn from_embedding_response(response: &Value) -> Result<Self, &'static str> {
        let usage = response
            .get("usage")
            .and_then(Value::as_object)
            .ok_or("usage is missing")?;
        let read = |field: &str| -> Result<Option<u64>, &'static str> {
            match usage.get(field) {
                None | Some(Value::Null) => Ok(None),
                Some(value) => value
                    .as_u64()
                    .map(Some)
                    .ok_or("invalid embedding token usage"),
            }
        };
        let prompt = read("prompt_tokens")?;
        let total = read("total_tokens")?;
        if prompt.is_some() && total.is_some() && prompt != total {
            return Err("inconsistent embedding token usage");
        }
        if read("completion_tokens")?.is_some_and(|tokens| tokens != 0) {
            return Err("inconsistent embedding token usage");
        }
        let input = prompt.or(total).ok_or("embedding token usage is missing")?;
        let result = Self {
            input,
            output: 0,
            reasoning: 0,
            cache_read: 0,
            cache_creation: 0,
        };
        result.billable_tokens()?;
        Ok(result)
    }

    /// Matches the product's quota counter (input + output + reasoning).
    pub fn billable_tokens(&self) -> Result<u64, &'static str> {
        self.input
            .checked_add(self.output)
            .and_then(|n| n.checked_add(self.reasoning))
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or("token usage overflow")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TokenPrices {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_creation: f64,
    pub reasoning: f64,
}

impl TokenPrices {
    /// Read explicit per-million-token prices; absent input/output prices are
    /// unknown, not zero. Optional prices follow the current product defaults.
    pub fn from_record(record: &Value) -> Result<Self, &'static str> {
        let object = record.as_object().ok_or("pricing is missing")?;
        let read = |name: &str| -> Result<Option<f64>, &'static str> {
            match object.get(name) {
                None | Some(Value::Null) => Ok(None),
                Some(value) => value
                    .as_f64()
                    .filter(|v| v.is_finite() && *v >= 0.0)
                    .map(Some)
                    .ok_or("invalid token price"),
            }
        };
        let input = read("input")?.ok_or("input price is missing")?;
        let output = read("output")?.ok_or("output price is missing")?;
        Ok(Self {
            input,
            output,
            cache_read: read("cached")?.unwrap_or(input),
            cache_creation: read("cache_creation")?.unwrap_or(input),
            reasoning: read("reasoning")?.unwrap_or(output),
        })
    }

    /// Match the product's pricing for ordinary OpenAI-compatible token usage.
    pub fn cost_usd(&self, usage: &ChatUsage) -> Result<f64, &'static str> {
        if [
            self.input,
            self.output,
            self.cache_read,
            self.cache_creation,
            self.reasoning,
        ]
        .into_iter()
        .any(|price| !price.is_finite() || price < 0.0)
        {
            return Err("invalid token price");
        }
        let cached = usage
            .cache_read
            .checked_add(usage.cache_creation)
            .ok_or("invalid token usage")?;
        if cached > usage.input || usage.reasoning > usage.output {
            return Err("invalid token usage");
        }
        let cost = ((usage.input - cached) as f64 * self.input
            + usage.cache_read as f64 * self.cache_read
            + usage.cache_creation as f64 * self.cache_creation
            + (usage.output - usage.reasoning) as f64 * self.output
            + usage.reasoning as f64 * self.reasoning)
            / 1_000_000.0;
        if !cost.is_finite() || cost < 0.0 {
            return Err("invalid calculated cost");
        }
        Ok(cost)
    }
}

pub struct CompletedUsage<'a> {
    pub event_id: &'a str,
    pub key_id: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub usage: &'a ChatUsage,
    /// `None` means the model price was unresolved, never that it was free.
    pub prices: Option<&'a TokenPrices>,
    pub timestamp_ms: i64,
}

fn ledger_pricing_snapshot(
    prices: Option<&TokenPrices>,
    timestamp_ms: i64,
) -> Result<Option<String>, &'static str> {
    let Some(prices) = prices else {
        return Ok(None);
    };
    let captured_at = OffsetDateTime::from_unix_timestamp_nanos(timestamp_ms as i128 * 1_000_000)
        .map_err(|_| "invalid accounting timestamp")?
        .format(&Rfc3339)
        .map_err(|_| "invalid accounting timestamp")?;
    Ok(Some(
        serde_json::json!({
            "currency": "USD",
            "unit": "million-tokens",
            "source": "router-model-pricing",
            "capturedAt": captured_at,
            "input": prices.input,
            "output": prices.output,
            "cacheRead": prices.cache_read,
            "cacheWrite": prices.cache_creation,
            "reasoning": prices.reasoning,
            "serviceTierMultiplier": 1
        })
        .to_string(),
    ))
}

/// Atomically record one fully observed response in the product ledger and
/// TPM counter. An absent price is persisted as unknown, never free. Duplicate
/// event IDs are idempotent only when their persisted accounting values match. This is not admission:
/// callers must reserve quota and coordinate incomplete streams separately.
pub async fn record_completed_usage(
    pool: &SqlitePool,
    event: &CompletedUsage<'_>,
) -> Result<bool, &'static str> {
    record_usage(pool, event, false).await
}

/// Settle a dispatched reservation and its observed usage atomically. If the
/// provider exceeds the bound, quarantine it until explicit reconciliation.
pub async fn record_reserved_usage(
    pool: &SqlitePool,
    event: &CompletedUsage<'_>,
) -> Result<bool, &'static str> {
    record_usage(pool, event, true).await
}

async fn record_usage(
    pool: &SqlitePool,
    event: &CompletedUsage<'_>,
    reserved: bool,
) -> Result<bool, &'static str> {
    if event.event_id.is_empty()
        || event.event_id.len() > 256
        || event.key_id.is_empty()
        || event.key_id.len() > 512
        || event.model.is_empty()
        || event.model.len() > 256
        || crate::product_provider::chat_url(event.provider).is_none()
        || event.timestamp_ms < 0
    {
        return Err("invalid accounting event");
    }
    let billable = event.usage.billable_tokens()?;
    let cost = match event.prices {
        Some(prices) => prices.cost_usd(event.usage)?,
        None => 0.0,
    };
    let pricing_known = i64::from(event.prices.is_some());
    let unit_price_input = event.prices.map_or(0.0, |prices| prices.input);
    let unit_price_output = event.prices.map_or(0.0, |prices| prices.output);
    let pricing_snapshot = ledger_pricing_snapshot(event.prices, event.timestamp_ms)?;
    let usage_attributes = "{}";
    let input = i64::try_from(event.usage.input).map_err(|_| "invalid token usage")?;
    let output = i64::try_from(event.usage.output).map_err(|_| "invalid token usage")?;
    let reasoning = i64::try_from(event.usage.reasoning).map_err(|_| "invalid token usage")?;
    let cache_read = i64::try_from(event.usage.cache_read).map_err(|_| "invalid token usage")?;
    let cache_creation =
        i64::try_from(event.usage.cache_creation).map_err(|_| "invalid token usage")?;
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|_| "accounting unavailable")?;
    let key_exists: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM api_keys WHERE id = ? AND tenant_id = 'red')",
    )
    .bind(event.key_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| "accounting key unavailable")?;
    if key_exists != 1 {
        return Err("accounting key unavailable");
    }
    if reserved {
        let row = sqlx::query("SELECT reserved_tokens, reserved_usd, state, provider, model, pricing_snapshot FROM api_key_usage_reservations WHERE id = ? AND api_key_id = ?")
            .bind(event.event_id).bind(event.key_id).fetch_optional(&mut *tx).await.map_err(|_| "reservation unavailable")?;
        if let Some(row) = row {
            let state: String = row.try_get("state").map_err(|_| "invalid reservation")?;
            let token_bound: i64 = row
                .try_get("reserved_tokens")
                .map_err(|_| "invalid reservation")?;
            let usd_bound: f64 = row
                .try_get("reserved_usd")
                .map_err(|_| "invalid reservation")?;
            let provider: Option<String> =
                row.try_get("provider").map_err(|_| "invalid reservation")?;
            let model: Option<String> = row.try_get("model").map_err(|_| "invalid reservation")?;
            let snapshot: Option<String> = row
                .try_get("pricing_snapshot")
                .map_err(|_| "invalid reservation")?;
            if state != "dispatched"
                || token_bound < 0
                || !usd_bound.is_finite()
                || usd_bound < 0.0
                || provider.as_deref().is_some_and(|v| v != event.provider)
                || model.as_deref().is_some_and(|v| v != event.model)
            {
                return Err("invalid reservation");
            }
            match (snapshot, event.prices) {
                (Some(snapshot), Some(prices)) => {
                    let snapshot: Value =
                        serde_json::from_str(&snapshot).map_err(|_| "invalid reservation")?;
                    if TokenPrices::from_record(&snapshot)? != *prices {
                        return Err("invalid reservation price");
                    }
                }
                (None, None) => {}
                _ => return Err("invalid reservation price"),
            }
            if billable > token_bound as u64 || cost > usd_bound {
                sqlx::query("UPDATE api_key_usage_reservations SET reserved_tokens = 9007199254740991, reserved_usd = 1e300 WHERE id = ? AND api_key_id = ?")
                    .bind(event.event_id).bind(event.key_id).execute(&mut *tx).await.map_err(|_| "reservation unavailable")?;
                tx.commit().await.map_err(|_| "accounting unavailable")?;
                return Err("usage exceeds reservation; reconciliation required");
            }
        } else {
            let existing: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM request_cost_ledger WHERE event_id = ?)",
            )
            .bind(event.event_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| "cost ledger unavailable")?;
            if existing != 1 {
                return Err("reservation unavailable");
            }
        }
    }
    let inserted = sqlx::query("INSERT INTO request_cost_ledger (api_key_id, provider, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_reasoning, unit_price_input, unit_price_output, amount_usd, service_tier, success, timestamp, event_id, usage_attributes, pricing_known, pricing_snapshot, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'standard', 1, strftime('%Y-%m-%dT%H:%M:%fZ', ? / 1000.0, 'unixepoch'), ?, ?, ?, ?, 'red') ON CONFLICT(event_id) WHERE event_id IS NOT NULL DO NOTHING")
        .bind(event.key_id).bind(event.provider).bind(event.model).bind(input).bind(output)
        .bind(cache_read).bind(cache_creation).bind(reasoning).bind(unit_price_input).bind(unit_price_output)
        .bind(cost).bind(event.timestamp_ms).bind(event.event_id).bind(usage_attributes).bind(pricing_known)
        .bind(pricing_snapshot.as_deref()).execute(&mut *tx).await
        .map_err(|_| "cost ledger unavailable")?.rows_affected();
    if inserted == 0 {
        let row = sqlx::query("SELECT api_key_id, provider, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_reasoning, unit_price_input, unit_price_output, amount_usd, (timestamp = strftime('%Y-%m-%dT%H:%M:%fZ', ? / 1000.0, 'unixepoch')) AS same_time, tenant_id, success, usage_attributes, pricing_known, pricing_snapshot FROM request_cost_ledger WHERE event_id = ?")
            .bind(event.timestamp_ms).bind(event.event_id).fetch_optional(&mut *tx).await.map_err(|_| "cost ledger unavailable")?
            .ok_or("cost ledger unavailable")?;
        let same = row.try_get::<String, _>("api_key_id").ok().as_deref() == Some(event.key_id)
            && row.try_get::<String, _>("provider").ok().as_deref() == Some(event.provider)
            && row.try_get::<String, _>("model").ok().as_deref() == Some(event.model)
            && row.try_get::<i64, _>("tokens_input").ok() == Some(input)
            && row.try_get::<i64, _>("tokens_output").ok() == Some(output)
            && row.try_get::<i64, _>("tokens_reasoning").ok() == Some(reasoning)
            && row.try_get::<i64, _>("tokens_cache_read").ok() == Some(cache_read)
            && row.try_get::<i64, _>("tokens_cache_creation").ok() == Some(cache_creation)
            && row.try_get::<f64, _>("unit_price_input").ok() == Some(unit_price_input)
            && row.try_get::<f64, _>("unit_price_output").ok() == Some(unit_price_output)
            && row.try_get::<f64, _>("amount_usd").ok() == Some(cost)
            && row.try_get::<i64, _>("same_time").ok() == Some(1)
            && row.try_get::<String, _>("tenant_id").ok().as_deref() == Some("red")
            && row.try_get::<i64, _>("success").ok() == Some(1)
            && row.try_get::<String, _>("usage_attributes").ok().as_deref()
                == Some(usage_attributes)
            && row.try_get::<i64, _>("pricing_known").ok() == Some(pricing_known)
            && row
                .try_get::<Option<String>, _>("pricing_snapshot")
                .ok()
                .flatten()
                == pricing_snapshot;
        if !same {
            return Err("accounting event ID collision");
        }
        if reserved {
            sqlx::query("DELETE FROM api_key_usage_reservations WHERE id = ? AND api_key_id = ? AND state = 'dispatched'")
                .bind(event.event_id).bind(event.key_id).execute(&mut *tx).await.map_err(|_| "reservation unavailable")?;
        }
        tx.commit().await.map_err(|_| "accounting unavailable")?;
        return Ok(false);
    }
    if billable > 0 {
        sqlx::query("INSERT INTO api_key_quota_counters (api_key_id, dimension_key, bucket_index, consumed, updated_at) VALUES (?, 'key-quota:tpm', ?, ?, ?) ON CONFLICT(api_key_id, dimension_key, bucket_index) DO UPDATE SET consumed = consumed + excluded.consumed, updated_at = excluded.updated_at")
            .bind(event.key_id).bind(event.timestamp_ms / 60_000).bind(billable as i64).bind(event.timestamp_ms)
            .execute(&mut *tx).await.map_err(|_| "token counter unavailable")?;
    }
    if reserved {
        sqlx::query("DELETE FROM api_key_usage_reservations WHERE id = ? AND api_key_id = ? AND state = 'dispatched'")
            .bind(event.event_id).bind(event.key_id).execute(&mut *tx).await.map_err(|_| "reservation unavailable")?;
    }
    tx.commit().await.map_err(|_| "accounting unavailable")?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn accounting_database() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(include_str!(
            "../../../src/lib/db/migrations/182_request_cost_ledger_and_key_quota.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../../src/lib/db/migrations/219_cost_ledger_recovery.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../../src/lib/db/migrations/226_shared_usage_reservations.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::raw_sql("CREATE TABLE api_keys (id TEXT PRIMARY KEY, tenant_id TEXT); INSERT INTO api_keys VALUES ('key', 'red'); ALTER TABLE request_cost_ledger ADD COLUMN tenant_id TEXT;")
            .execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!(
            "../../../src/lib/db/migrations/224_usage_reporting_context.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../../src/lib/db/migrations/225_usage_pricing_snapshot.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn reserved_usage_settles_atomically_and_overruns_are_quarantined() {
        let pool = accounting_database().await;
        let usage = ChatUsage::from_response(
            &json!({"usage":{"prompt_tokens":100,"completion_tokens":50}}),
        )
        .unwrap();
        let prices = TokenPrices::from_record(&json!({"input":2,"output":4})).unwrap();
        let mut event = CompletedUsage {
            event_id: "event-1",
            key_id: "key",
            provider: "openai",
            model: "gpt",
            usage: &usage,
            prices: Some(&prices),
            timestamp_ms: 1_700_000_000_000,
        };
        sqlx::query("INSERT INTO api_key_usage_reservations (id,api_key_id,reserved_tokens,reserved_usd,created_at,state) VALUES ('event-1','key',150,0.001,1700000000000,'reserved')").execute(&pool).await.unwrap();
        assert_eq!(
            record_reserved_usage(&pool, &event).await,
            Err("invalid reservation")
        );
        sqlx::query(
            "UPDATE api_key_usage_reservations SET state = 'dispatched', provider = 'openai', model = 'gpt', pricing_snapshot = '{\"input\":2,\"output\":4}' WHERE id = 'event-1'",
        )
        .execute(&pool)
        .await
        .unwrap();
        event.model = "wrong";
        assert_eq!(
            record_reserved_usage(&pool, &event).await,
            Err("invalid reservation")
        );
        event.model = "gpt";
        assert_eq!(record_reserved_usage(&pool, &event).await, Ok(true));
        assert_eq!(record_reserved_usage(&pool, &event).await, Ok(false));
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM api_key_usage_reservations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        sqlx::query("INSERT INTO api_key_usage_reservations (id,api_key_id,reserved_tokens,reserved_usd,created_at,state,pricing_snapshot) VALUES ('event-2','key',100,0.001,1700000000000,'dispatched','{\"input\":2,\"output\":4}')").execute(&pool).await.unwrap();
        event.event_id = "event-2";
        assert_eq!(
            record_reserved_usage(&pool, &event).await,
            Err("usage exceeds reservation; reconciliation required")
        );
        let tokens: i64 = sqlx::query_scalar(
            "SELECT reserved_tokens FROM api_key_usage_reservations WHERE id = 'event-2'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tokens, 9_007_199_254_740_991);
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM request_cost_ledger WHERE event_id = 'event-2'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn settlement_failure_keeps_the_dispatched_reservation() {
        let pool = accounting_database().await;
        let usage = ChatUsage::from_response(
            &json!({"usage":{"prompt_tokens":100,"completion_tokens":50}}),
        )
        .unwrap();
        let prices = TokenPrices::from_record(&json!({"input":2,"output":4})).unwrap();
        let event = CompletedUsage {
            event_id: "event-fail",
            key_id: "key",
            provider: "openai",
            model: "gpt",
            usage: &usage,
            prices: Some(&prices),
            timestamp_ms: 1_700_000_000_000,
        };
        sqlx::query("INSERT INTO api_key_usage_reservations (id,api_key_id,reserved_tokens,reserved_usd,created_at,state,pricing_snapshot) VALUES ('event-fail','key',150,0.001,1700000000000,'dispatched','{\"input\":2,\"output\":4}')").execute(&pool).await.unwrap();
        sqlx::query("CREATE TRIGGER fail_counter BEFORE INSERT ON api_key_quota_counters BEGIN SELECT RAISE(ABORT, 'failure'); END").execute(&pool).await.unwrap();
        assert_eq!(
            record_reserved_usage(&pool, &event).await,
            Err("token counter unavailable")
        );
        let ledger: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM request_cost_ledger WHERE event_id='event-fail'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM api_key_usage_reservations WHERE id='event-fail' AND state='dispatched'").fetch_one(&pool).await.unwrap();
        assert_eq!((ledger, pending), (0, 1));
    }

    #[tokio::test]
    async fn completed_usage_is_idempotent_and_atomic_with_token_counter() {
        let pool = accounting_database().await;
        let usage = ChatUsage::from_response(
            &json!({"usage":{"prompt_tokens":100,"completion_tokens":50}}),
        )
        .unwrap();
        let prices = TokenPrices::from_record(&json!({"input":2,"output":4})).unwrap();
        let mut event = CompletedUsage {
            event_id: "event-1",
            key_id: "key",
            provider: "openai",
            model: "gpt",
            usage: &usage,
            prices: Some(&prices),
            timestamp_ms: 1_700_000_000_000,
        };
        assert_eq!(record_completed_usage(&pool, &event).await, Ok(true));
        assert_eq!(record_completed_usage(&pool, &event).await, Ok(false));
        event.timestamp_ms += 60_000;
        assert_eq!(
            record_completed_usage(&pool, &event).await,
            Err("accounting event ID collision")
        );
        let (count, amount): (i64, f64) =
            sqlx::query_as("SELECT count(*), sum(amount_usd) FROM request_cost_ledger")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
        assert!((amount - 0.0004).abs() < 1e-12);
        let tokens: f64 = sqlx::query_scalar("SELECT consumed FROM api_key_quota_counters WHERE api_key_id = 'key' AND dimension_key = 'key-quota:tpm'").fetch_one(&pool).await.unwrap();
        assert_eq!(tokens, 150.0);
        let (known, snapshot, attributes): (i64, Option<String>, String) = sqlx::query_as(
            "SELECT pricing_known, pricing_snapshot, usage_attributes FROM request_cost_ledger WHERE event_id = 'event-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let snapshot: Value = serde_json::from_str(snapshot.as_deref().unwrap()).unwrap();
        assert_eq!(known, 1);
        assert_eq!(attributes, "{}");
        assert_eq!(snapshot["currency"], "USD");
        assert_eq!(snapshot["unit"], "million-tokens");
        assert_eq!(snapshot["capturedAt"], "2023-11-14T22:13:20Z");
        assert_eq!(snapshot["input"], 2.0);
        assert_eq!(snapshot["output"], 4.0);
        sqlx::query("CREATE TRIGGER fail_counter BEFORE INSERT ON api_key_quota_counters BEGIN SELECT RAISE(ABORT, 'failure'); END").execute(&pool).await.unwrap();
        event.event_id = "event-2";
        assert_eq!(
            record_completed_usage(&pool, &event).await,
            Err("token counter unavailable")
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM request_cost_ledger")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count, 1,
            "ledger insert must roll back when the counter fails"
        );
    }

    #[tokio::test]
    async fn unpriced_usage_is_explicitly_unknown_and_still_counts_tokens() {
        let pool = accounting_database().await;
        let usage = ChatUsage::from_response(
            &json!({"usage":{"prompt_tokens":100,"completion_tokens":50}}),
        )
        .unwrap();
        let event = CompletedUsage {
            event_id: "unpriced",
            key_id: "key",
            provider: "openai",
            model: "new-model",
            usage: &usage,
            prices: None,
            timestamp_ms: 1_700_000_000_000,
        };
        assert_eq!(record_completed_usage(&pool, &event).await, Ok(true));
        assert_eq!(record_completed_usage(&pool, &event).await, Ok(false));
        let row: (i64, f64, f64, f64, Option<String>, String) = sqlx::query_as(
            "SELECT pricing_known, unit_price_input, unit_price_output, amount_usd, pricing_snapshot, usage_attributes FROM request_cost_ledger WHERE event_id = 'unpriced'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, (0, 0.0, 0.0, 0.0, None, "{}".to_owned()));
        let tokens: f64 = sqlx::query_scalar("SELECT consumed FROM api_key_quota_counters WHERE api_key_id = 'key' AND dimension_key = 'key-quota:tpm'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(tokens, 150.0);
    }

    #[test]
    fn normalizes_breakdowns_and_matches_product_cost_math() {
        let usage = ChatUsage::from_response(&json!({"usage":{
            "prompt_tokens":100,"completion_tokens":50,
            "prompt_tokens_details":{"cached_tokens":20,"cache_creation_tokens":10},
            "completion_tokens_details":{"reasoning_tokens":10}
        }}))
        .unwrap();
        assert_eq!(usage.billable_tokens().unwrap(), 160);
        let prices = TokenPrices::from_record(
            &json!({"input":2,"output":4,"cached":0.5,"cache_creation":3,"reasoning":6}),
        )
        .unwrap();
        assert!((prices.cost_usd(&usage).unwrap() - 0.0004).abs() < 1e-12);
    }

    #[test]
    fn normalizes_embedding_usage_without_inventing_output_tokens() {
        for response in [
            json!({"usage":{"prompt_tokens":42}}),
            json!({"usage":{"total_tokens":42}}),
            json!({"usage":{"prompt_tokens":42,"total_tokens":42,"completion_tokens":0}}),
        ] {
            assert_eq!(
                ChatUsage::from_embedding_response(&response).unwrap(),
                ChatUsage {
                    input: 42,
                    output: 0,
                    reasoning: 0,
                    cache_read: 0,
                    cache_creation: 0,
                }
            );
        }
        for response in [
            json!({}),
            json!({"usage":{}}),
            json!({"usage":{"prompt_tokens":42,"total_tokens":43}}),
            json!({"usage":{"total_tokens":42,"completion_tokens":1}}),
            json!({"usage":{"total_tokens":-1}}),
        ] {
            assert!(ChatUsage::from_embedding_response(&response).is_err());
        }
    }

    #[test]
    fn missing_or_inconsistent_usage_and_unknown_prices_fail_closed() {
        for response in [
            json!({}),
            json!({"usage":{"prompt_tokens":0}}),
            json!({"usage":{"prompt_tokens":-1,"completion_tokens":0}}),
            json!({"usage":{"prompt_tokens":1,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":2}}}),
            json!({"usage":{"prompt_tokens":1,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":2}}}),
            json!({"usage":{"prompt_tokens":u64::MAX,"completion_tokens":1}}),
        ] {
            assert!(ChatUsage::from_response(&response).is_err());
        }
        assert!(TokenPrices::from_record(&json!({"input":1})).is_err());
        assert!(TokenPrices::from_record(&json!({"input":-1,"output":1})).is_err());
        assert_eq!(
            TokenPrices::from_record(&json!({"input":0,"output":0}))
                .unwrap()
                .input,
            0.0
        );
    }
}
