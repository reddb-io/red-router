//! The per-attempt request log (legacy `call_logs`, written by `saveCallLog`
//! from `attemptLogging.ts`).
//!
//! Every upstream attempt of a proxied request leaves one row: which account
//! and model served it, the status and failure class, the time to response
//! headers and whether the client streamed. The attempts of one request share
//! a `request_id`, so a fallback chain reads in order. Tokens and cost are not
//! copied here: a row names the usage ledger event of its attempt, and the
//! report joins the ledger, so a streamed answer settled after the headers
//! still shows its usage. Like the usage ledger, the log lives in the SQL
//! database only.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use sqlx::{Any, AnyPool, QueryBuilder, Row};

pub(crate) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_request_log (id TEXT PRIMARY KEY, created_at_unix_ms BIGINT NOT NULL, request_id TEXT NOT NULL, attempt BIGINT NOT NULL, tenant_id TEXT NOT NULL, key_id TEXT NOT NULL, protocol TEXT NOT NULL, requested_model TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL, provider_id TEXT NOT NULL, status BIGINT NOT NULL, error TEXT NOT NULL, duration_ms BIGINT NOT NULL, stream BIGINT NOT NULL, usage_event_id TEXT NOT NULL)";
pub(crate) const CREATE_TIME_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_request_log_time ON redrouter_request_log (created_at_unix_ms, id)";
pub(crate) const CREATE_TENANT_TIME_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_request_log_tenant_time ON redrouter_request_log (tenant_id, created_at_unix_ms, id)";
pub(crate) const CREATE_REQUEST_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_request_log_request ON redrouter_request_log (request_id, attempt)";

const INSERT: &str = "INSERT INTO redrouter_request_log (id, created_at_unix_ms, request_id, attempt, tenant_id, key_id, protocol, requested_model, model, provider, provider_id, status, error, duration_ms, stream, usage_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)";

/// Longest text field kept; longer values are cut on a character boundary.
const MAX_FIELD: usize = 256;
pub(crate) const MAX_PAGE: i64 = 200;

/// One attempt, as the proxy records it.
#[derive(Clone, Debug)]
pub(crate) struct Attempt {
    pub id: String,
    pub created_at_unix_ms: i64,
    pub request_id: String,
    pub attempt: i64,
    pub tenant_id: String,
    pub key_id: String,
    pub protocol: &'static str,
    pub requested_model: String,
    pub model: String,
    pub provider: String,
    pub provider_id: String,
    pub status: u16,
    pub error: String,
    pub duration_ms: i64,
    pub stream: bool,
    pub usage_event_id: String,
}

fn bounded(value: &str) -> String {
    if value.len() <= MAX_FIELD {
        return value.to_owned();
    }
    let mut end = MAX_FIELD;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

pub(crate) async fn insert(pool: &AnyPool, attempt: &Attempt) -> Result<(), &'static str> {
    sqlx::query(INSERT)
        .bind(bounded(&attempt.id))
        .bind(attempt.created_at_unix_ms)
        .bind(bounded(&attempt.request_id))
        .bind(attempt.attempt)
        .bind(bounded(&attempt.tenant_id))
        .bind(bounded(&attempt.key_id))
        .bind(attempt.protocol)
        .bind(bounded(&attempt.requested_model))
        .bind(bounded(&attempt.model))
        .bind(bounded(&attempt.provider))
        .bind(bounded(&attempt.provider_id))
        .bind(i64::from(attempt.status))
        .bind(bounded(&attempt.error))
        .bind(attempt.duration_ms.max(0))
        .bind(i64::from(attempt.stream))
        .bind(bounded(&attempt.usage_event_id))
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|_| "cannot write request log")
}

/// Legacy `retention.callLogs` (30 days by default) and
/// `CALL_LOGS_TABLE_MAX_ROWS` (100,000): rows older than the retention, and
/// the oldest rows past the cap, are deleted.
pub(crate) const DEFAULT_RETENTION_DAYS: i64 = 30;
pub(crate) const DEFAULT_MAX_ROWS: i64 = 100_000;
/// One background prune per this many writes.
pub(crate) const PRUNE_EVERY: u64 = 500;

static WRITES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn positive_env(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

/// The configured retention: `CALL_LOG_RETENTION_DAYS` and
/// `CALL_LOGS_TABLE_MAX_ROWS`, else the legacy defaults.
pub(crate) fn retention() -> (i64, i64) {
    (
        positive_env("CALL_LOG_RETENTION_DAYS", DEFAULT_RETENTION_DAYS),
        positive_env("CALL_LOGS_TABLE_MAX_ROWS", DEFAULT_MAX_ROWS),
    )
}

/// Whether this write should also prune (every `PRUNE_EVERY`-th write).
pub(crate) fn prune_due() -> bool {
    WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % PRUNE_EVERY == PRUNE_EVERY - 1
}

/// Delete rows older than the retention, then the oldest rows past the cap.
pub(crate) async fn prune(
    pool: &AnyPool,
    now_unix_ms: i64,
    retention_days: i64,
    max_rows: i64,
) -> Result<u64, &'static str> {
    let cutoff = now_unix_ms.saturating_sub(retention_days.saturating_mul(24 * 60 * 60 * 1000));
    let mut deleted =
        sqlx::query("DELETE FROM redrouter_request_log WHERE created_at_unix_ms < $1")
            .bind(cutoff)
            .execute(pool)
            .await
            .map_err(|_| "cannot prune request log")?
            .rows_affected();
    // The newest row beyond the cap marks where the kept rows end.
    let boundary: Option<(i64, String)> = sqlx::query(
        "SELECT created_at_unix_ms, id FROM redrouter_request_log ORDER BY created_at_unix_ms DESC, id DESC LIMIT 1 OFFSET $1",
    )
    .bind(max_rows.saturating_sub(1).max(0))
    .fetch_optional(pool)
    .await
    .map_err(|_| "cannot prune request log")?
    .map(|row| {
        Ok::<_, &'static str>((
            row.try_get::<i64, _>("created_at_unix_ms")
                .map_err(|_| "cannot prune request log")?,
            row.try_get::<String, _>("id")
                .map_err(|_| "cannot prune request log")?,
        ))
    })
    .transpose()?;
    if let Some((timestamp, id)) = boundary {
        deleted += sqlx::query(
            "DELETE FROM redrouter_request_log WHERE created_at_unix_ms < $1 OR (created_at_unix_ms = $1 AND id < $2)",
        )
        .bind(timestamp)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|_| "cannot prune request log")?
        .rows_affected();
    }
    Ok(deleted)
}

/// Filters of `GET /api/admin/request-log`.
#[derive(Default, Debug)]
pub(crate) struct Query {
    pub tenant_id: Option<String>,
    pub key_id: Option<String>,
    pub request_id: Option<String>,
    pub provider_id: Option<String>,
    /// `ok` (2xx) or `error` (anything else).
    pub outcome: Option<String>,
    pub from_unix_ms: i64,
    pub to_unix_ms: i64,
    pub limit: i64,
    pub cursor: Option<String>,
}

/// A logged attempt with the usage its ledger event settled, if any.
#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct Entry {
    pub id: String,
    pub created_at_unix_ms: i64,
    pub request_id: String,
    pub attempt: i64,
    pub tenant_id: String,
    pub key_id: String,
    pub protocol: String,
    pub requested_model: String,
    pub model: String,
    pub provider: String,
    pub provider_id: String,
    pub status: i64,
    pub error: Option<String>,
    pub duration_ms: i64,
    pub stream: bool,
    pub usage: Option<Usage>,
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct Usage {
    pub tokens_input: i64,
    pub tokens_output: i64,
    pub tokens_cache_read: i64,
    pub tokens_cache_creation: i64,
    pub tokens_reasoning: i64,
    /// `None` when the model had no known price.
    pub amount_usd: Option<f64>,
}

#[derive(Debug, Serialize)]
pub(crate) struct Page {
    pub requests: Vec<Entry>,
    pub next_cursor: Option<String>,
}

fn valid_filter(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_none_or(|value| !value.is_empty() && value.len() <= 128)
}

fn encode_cursor(entry: &Entry) -> String {
    format!(
        "{}.{}",
        entry.created_at_unix_ms,
        URL_SAFE_NO_PAD.encode(entry.id.as_bytes())
    )
}

fn decode_cursor(value: Option<&str>) -> Result<Option<(i64, String)>, &'static str> {
    let Some(value) = value else {
        return Ok(None);
    };
    let invalid = "invalid request log query";
    if value.is_empty() || value.len() > 512 {
        return Err(invalid);
    }
    let (timestamp, id) = value.split_once('.').ok_or(invalid)?;
    let timestamp = timestamp.parse::<i64>().map_err(|_| invalid)?;
    let id =
        String::from_utf8(URL_SAFE_NO_PAD.decode(id).map_err(|_| invalid)?).map_err(|_| invalid)?;
    if id.is_empty() || id.len() > MAX_FIELD {
        return Err(invalid);
    }
    Ok(Some((timestamp, id)))
}

pub(crate) fn validate(query: &Query) -> Result<(), &'static str> {
    if !(valid_filter(&query.tenant_id)
        && valid_filter(&query.key_id)
        && valid_filter(&query.request_id)
        && valid_filter(&query.provider_id))
        || query
            .outcome
            .as_deref()
            .is_some_and(|outcome| !matches!(outcome, "ok" | "error"))
        || query.from_unix_ms < 0
        || query.from_unix_ms >= query.to_unix_ms
        || !(1..=MAX_PAGE).contains(&query.limit)
    {
        return Err("invalid request log query");
    }
    decode_cursor(query.cursor.as_deref())?;
    Ok(())
}

/// Newest first, `limit` rows per page, with the cursor of the next page.
pub(crate) async fn list(pool: &AnyPool, query: &Query) -> Result<Page, &'static str> {
    validate(query)?;
    let cursor = decode_cursor(query.cursor.as_deref())?;
    let mut rows = QueryBuilder::<Any>::new(
        "SELECT r.id, r.created_at_unix_ms, r.request_id, r.attempt, r.tenant_id, r.key_id, r.protocol, r.requested_model, r.model, r.provider, r.provider_id, r.status, r.error, r.duration_ms, r.stream, l.tokens_input, l.tokens_output, l.tokens_cache_read, l.tokens_cache_creation, l.tokens_reasoning, l.amount_microusd, l.pricing_known FROM redrouter_request_log r LEFT JOIN redrouter_usage_ledger l ON r.usage_event_id <> '' AND l.event_id = r.usage_event_id WHERE r.created_at_unix_ms >= ",
    );
    rows.push_bind(query.from_unix_ms)
        .push(" AND r.created_at_unix_ms < ")
        .push_bind(query.to_unix_ms);
    for (column, value) in [
        ("r.tenant_id", &query.tenant_id),
        ("r.key_id", &query.key_id),
        ("r.request_id", &query.request_id),
        ("r.provider_id", &query.provider_id),
    ] {
        if let Some(value) = value {
            rows.push(format!(" AND {column} = "))
                .push_bind(value.clone());
        }
    }
    match query.outcome.as_deref() {
        Some("ok") => {
            rows.push(" AND r.status >= 200 AND r.status < 300");
        }
        Some("error") => {
            rows.push(" AND (r.status < 200 OR r.status >= 300)");
        }
        _ => {}
    }
    if let Some((timestamp, id)) = &cursor {
        rows.push(" AND (r.created_at_unix_ms < ")
            .push_bind(*timestamp)
            .push(" OR (r.created_at_unix_ms = ")
            .push_bind(*timestamp)
            .push(" AND r.id < ")
            .push_bind(id.clone())
            .push("))");
    }
    rows.push(" ORDER BY r.created_at_unix_ms DESC, r.id DESC LIMIT ")
        .push_bind(query.limit + 1);
    let mut rows = rows
        .build()
        .fetch_all(pool)
        .await
        .map_err(|_| "request log unavailable")?;
    let page_size = usize::try_from(query.limit).map_err(|_| "invalid request log query")?;
    let has_more = rows.len() > page_size;
    rows.truncate(page_size);
    let invalid = "invalid request log";
    let requests = rows
        .iter()
        .map(|row| {
            let text = |name: &str| row.try_get::<String, _>(name).map_err(|_| invalid);
            let integer = |name: &str| row.try_get::<i64, _>(name).map_err(|_| invalid);
            let optional = |name: &str| row.try_get::<Option<i64>, _>(name).map_err(|_| invalid);
            let usage = match optional("tokens_input")? {
                None => None,
                Some(tokens_input) => Some(Usage {
                    tokens_input,
                    tokens_output: optional("tokens_output")?.unwrap_or_default(),
                    tokens_cache_read: optional("tokens_cache_read")?.unwrap_or_default(),
                    tokens_cache_creation: optional("tokens_cache_creation")?.unwrap_or_default(),
                    tokens_reasoning: optional("tokens_reasoning")?.unwrap_or_default(),
                    amount_usd: (optional("pricing_known")? == Some(1)).then(|| {
                        optional("amount_microusd")
                            .ok()
                            .flatten()
                            .unwrap_or_default() as f64
                            / 1_000_000.0
                    }),
                }),
            };
            let error = text("error")?;
            Ok(Entry {
                id: text("id")?,
                created_at_unix_ms: integer("created_at_unix_ms")?,
                request_id: text("request_id")?,
                attempt: integer("attempt")?,
                tenant_id: text("tenant_id")?,
                key_id: text("key_id")?,
                protocol: text("protocol")?,
                requested_model: text("requested_model")?,
                model: text("model")?,
                provider: text("provider")?,
                provider_id: text("provider_id")?,
                status: integer("status")?,
                error: (!error.is_empty()).then_some(error),
                duration_ms: integer("duration_ms")?,
                stream: integer("stream")? == 1,
                usage,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    let next_cursor = has_more
        .then(|| requests.last().map(encode_cursor))
        .flatten();
    Ok(Page {
        requests,
        next_cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query() -> Query {
        Query {
            from_unix_ms: 0,
            to_unix_ms: 10,
            limit: 50,
            ..Query::default()
        }
    }

    #[test]
    fn long_fields_are_cut_on_a_character_boundary() {
        assert_eq!(bounded("short"), "short");
        let long = "é".repeat(200);
        let cut = bounded(&long);
        assert!(cut.len() <= MAX_FIELD && long.starts_with(&cut));
        assert_eq!(cut.chars().count(), MAX_FIELD / 2);
    }

    #[test]
    fn a_cursor_round_trips_and_garbage_is_refused() {
        let entry = Entry {
            id: "rq_1".to_owned(),
            created_at_unix_ms: 1_700_000_000_000,
            request_id: String::new(),
            attempt: 0,
            tenant_id: String::new(),
            key_id: String::new(),
            protocol: String::new(),
            requested_model: String::new(),
            model: String::new(),
            provider: String::new(),
            provider_id: String::new(),
            status: 200,
            error: None,
            duration_ms: 1,
            stream: false,
            usage: None,
        };
        let cursor = encode_cursor(&entry);
        assert_eq!(
            decode_cursor(Some(&cursor)).unwrap(),
            Some((1_700_000_000_000, "rq_1".to_owned()))
        );
        for bad in ["", "nodot", "x.cnFfMQ", "1.!!!", "1."] {
            assert!(decode_cursor(Some(bad)).is_err(), "{bad}");
        }
    }

    fn attempt(id: &str, created_at_unix_ms: i64) -> Attempt {
        Attempt {
            id: id.to_owned(),
            created_at_unix_ms,
            request_id: format!("rq_{id}"),
            attempt: 0,
            tenant_id: "red".to_owned(),
            key_id: String::new(),
            protocol: "chat",
            requested_model: "m".to_owned(),
            model: "m".to_owned(),
            provider: "p".to_owned(),
            provider_id: "p".to_owned(),
            status: 200,
            error: String::new(),
            duration_ms: 1,
            stream: false,
            usage_event_id: String::new(),
        }
    }

    #[tokio::test]
    async fn pruning_keeps_the_retention_window_and_the_newest_rows() {
        let database =
            crate::storage::Database::connect(crate::storage::Backend::Sqlite, "sqlite::memory:")
                .await
                .unwrap();
        let pool = database.sql_pool().unwrap();
        let day = 24 * 60 * 60 * 1000;
        let now = 100 * day;
        for (id, age_days) in [("old", 31), ("a", 3), ("b", 2), ("c", 1)] {
            insert(pool, &attempt(id, now - age_days * day))
                .await
                .unwrap();
        }
        // 30 days drops "old"; a cap of two keeps the two newest.
        assert_eq!(prune(pool, now, 30, 2).await.unwrap(), 2);
        let page = list(
            pool,
            &Query {
                from_unix_ms: 0,
                to_unix_ms: now + 1,
                limit: 10,
                ..Query::default()
            },
        )
        .await
        .unwrap();
        let ids: Vec<&str> = page
            .requests
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(ids, ["c", "b"]);
        // Nothing left to prune.
        assert_eq!(prune(pool, now, 30, 2).await.unwrap(), 0);
        assert_eq!(retention(), (DEFAULT_RETENTION_DAYS, DEFAULT_MAX_ROWS));
    }

    #[test]
    fn queries_are_bounded() {
        assert!(validate(&query()).is_ok());
        let cases: [fn(&mut Query); 6] = [
            |q| q.limit = 0,
            |q| q.limit = MAX_PAGE + 1,
            |q| q.to_unix_ms = q.from_unix_ms,
            |q| q.outcome = Some("maybe".to_owned()),
            |q| q.key_id = Some(String::new()),
            |q| q.cursor = Some("bad".to_owned()),
        ];
        for case in cases {
            let mut q = query();
            case(&mut q);
            assert!(validate(&q).is_err(), "{q:?}");
        }
        let mut ok = query();
        ok.outcome = Some("error".to_owned());
        ok.request_id = Some("rq".to_owned());
        assert!(validate(&ok).is_ok());
    }
}
