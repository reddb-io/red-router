//! SQLite-first shared spend budgets for Rust-owned client keys.
//!
//! Admission runs inside the same `BEGIN IMMEDIATE` transaction that creates
//! the usage reservation. Independent proxy processes therefore observe both
//! settled ledger rows and every outstanding hold before admitting traffic.

use crate::storage::Database;
use serde::{Deserialize, Serialize};
use sqlx::{pool::PoolConnection, Any, QueryBuilder, Row};
use std::sync::Arc;
use time::{Date, Month, OffsetDateTime, Time};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BudgetInput {
    #[serde(default)]
    pub tenant_id: Option<String>,
    pub name: String,
    pub max_spend_usd: f64,
    pub reservation_spend_usd: f64,
    pub duration: String,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
    #[serde(default)]
    pub key_ids: Vec<String>,
}

fn enabled_default() -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
pub struct BudgetView {
    pub id: String,
    pub tenant_id: String,
    pub name: String,
    pub max_spend_usd: f64,
    pub reservation_spend_usd: f64,
    pub duration: String,
    pub enabled: bool,
    pub key_ids: Vec<String>,
    pub spent_usd: f64,
    pub reserved_usd: f64,
    pub window_start_unix_ms: i64,
    pub reset_at_unix_ms: Option<i64>,
    pub revision: String,
}

#[derive(Clone, Debug)]
struct Budget {
    id: String,
    tenant_id: String,
    name: String,
    max_microusd: i64,
    reservation_microusd: i64,
    duration: String,
    enabled: bool,
    key_ids: Vec<String>,
    revision: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ReservationPolicy {
    pub(crate) microusd: i64,
}

pub(crate) async fn reservation_policy(
    database: &Arc<Database>,
    tenant_id: &str,
    key_id: &str,
) -> Result<Option<ReservationPolicy>, &'static str> {
    let pool = database
        .sql_pool()
        .ok_or("shared budgets require SQLite storage")?;
    let budgets = read_budgets(pool, Some(tenant_id)).await?;
    let microusd = budgets
        .into_iter()
        .filter(|budget| budget.enabled && applies(budget, key_id))
        .map(|budget| budget.reservation_microusd)
        .max();
    Ok(microusd.map(|microusd| ReservationPolicy { microusd }))
}

pub(crate) async fn admit_in(
    connection: &mut PoolConnection<Any>,
    tenant_id: &str,
    key_id: &str,
    reserved_microusd: i64,
    now_ms: i64,
) -> Result<bool, &'static str> {
    if reserved_microusd < 0 {
        return Err("invalid shared budget reservation");
    }
    let rows = sqlx::query("SELECT id,tenant_id,name,max_microusd,reservation_microusd,duration,enabled,key_ids_json,revision FROM redrouter_control_budgets WHERE tenant_id=$1 AND enabled=1 ORDER BY id")
        .bind(tenant_id)
        .fetch_all(&mut **connection)
        .await
        .map_err(|_| "shared budget storage unavailable")?;
    for row in rows {
        let budget = decode_budget(&row)?;
        if !applies(&budget, key_id) {
            continue;
        }
        if reserved_microusd == 0 {
            return Err("shared spend budget requires a priced reservation");
        }
        let (window_start, _) = budget_window(&budget.duration, now_ms)?;
        let spent = ledger_total(connection, &budget, window_start).await?;
        let held = reservation_total(connection, &budget, window_start).await?;
        if spent
            .checked_add(held)
            .and_then(|value| value.checked_add(reserved_microusd))
            .is_none_or(|value| value > budget.max_microusd)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

pub async fn list(
    database: &Arc<Database>,
    tenant_id: Option<&str>,
    now_ms: i64,
) -> Result<Vec<BudgetView>, &'static str> {
    let pool = database
        .sql_pool()
        .ok_or("shared budgets require SQLite storage")?;
    let budgets = read_budgets(pool, tenant_id).await?;
    let mut views = Vec::with_capacity(budgets.len());
    for budget in budgets {
        let (window_start, reset_at) = budget_window(&budget.duration, now_ms)?;
        let spent = ledger_total_pool(pool, &budget, window_start).await?;
        let reserved = reservation_total_pool(pool, &budget, window_start).await?;
        views.push(BudgetView {
            id: budget.id,
            tenant_id: budget.tenant_id,
            name: budget.name,
            max_spend_usd: micros_to_usd(budget.max_microusd),
            reservation_spend_usd: micros_to_usd(budget.reservation_microusd),
            duration: budget.duration,
            enabled: budget.enabled,
            key_ids: budget.key_ids,
            spent_usd: micros_to_usd(spent),
            reserved_usd: micros_to_usd(reserved),
            window_start_unix_ms: window_start,
            reset_at_unix_ms: reset_at,
            revision: budget.revision.to_string(),
        });
    }
    Ok(views)
}

pub async fn upsert(
    database: &Arc<Database>,
    id: &str,
    tenant_id: &str,
    input: BudgetInput,
    revision: i64,
) -> Result<BudgetView, &'static str> {
    validate_id(id)?;
    validate_id(tenant_id)?;
    let input = validate_input(input)?;
    let pool = database
        .sql_pool()
        .ok_or("shared budgets require SQLite storage")?;
    let key_ids = serde_json::to_string(&input.key_ids).map_err(|_| "invalid shared budget")?;
    let affected = sqlx::query("INSERT INTO redrouter_control_budgets (id,tenant_id,name,max_microusd,reservation_microusd,duration,enabled,key_ids_json,revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET name=$3,max_microusd=$4,reservation_microusd=$5,duration=$6,enabled=$7,key_ids_json=$8,revision=$9 WHERE redrouter_control_budgets.tenant_id=$2")
        .bind(id)
        .bind(tenant_id)
        .bind(&input.name)
        .bind(usd_to_micros(input.max_spend_usd)?)
        .bind(usd_to_micros(input.reservation_spend_usd)?)
        .bind(&input.duration)
        .bind(i64::from(input.enabled))
        .bind(key_ids)
        .bind(revision)
        .execute(pool)
        .await
        .map_err(|_| "cannot save shared budget")?
        .rows_affected();
    if affected != 1 {
        return Err("shared budget belongs to another tenant");
    }
    list(database, Some(tenant_id), now_ms()?)
        .await?
        .into_iter()
        .find(|budget| budget.id == id)
        .ok_or("cannot reload shared budget")
}

pub async fn delete(
    database: &Arc<Database>,
    id: &str,
    tenant_id: Option<&str>,
) -> Result<bool, &'static str> {
    validate_id(id)?;
    let pool = database
        .sql_pool()
        .ok_or("shared budgets require SQLite storage")?;
    let affected = if let Some(tenant_id) = tenant_id {
        sqlx::query("DELETE FROM redrouter_control_budgets WHERE id=$1 AND tenant_id=$2")
            .bind(id)
            .bind(tenant_id)
            .execute(pool)
            .await
    } else {
        sqlx::query("DELETE FROM redrouter_control_budgets WHERE id=$1")
            .bind(id)
            .execute(pool)
            .await
    }
    .map_err(|_| "cannot delete shared budget")?
    .rows_affected();
    Ok(affected == 1)
}

async fn read_budgets(
    pool: &sqlx::AnyPool,
    tenant_id: Option<&str>,
) -> Result<Vec<Budget>, &'static str> {
    let rows = if let Some(tenant_id) = tenant_id {
        sqlx::query("SELECT id,tenant_id,name,max_microusd,reservation_microusd,duration,enabled,key_ids_json,revision FROM redrouter_control_budgets WHERE tenant_id=$1 ORDER BY name,id")
            .bind(tenant_id)
            .fetch_all(pool)
            .await
    } else {
        sqlx::query("SELECT id,tenant_id,name,max_microusd,reservation_microusd,duration,enabled,key_ids_json,revision FROM redrouter_control_budgets ORDER BY tenant_id,name,id")
            .fetch_all(pool)
            .await
    }
    .map_err(|_| "shared budget storage unavailable")?;
    rows.iter().map(decode_budget).collect()
}

fn decode_budget(row: &sqlx::any::AnyRow) -> Result<Budget, &'static str> {
    let text = |name| {
        row.try_get::<String, _>(name)
            .map_err(|_| "invalid shared budget")
    };
    let integer = |name| {
        row.try_get::<i64, _>(name)
            .map_err(|_| "invalid shared budget")
    };
    let key_ids = serde_json::from_str::<Vec<String>>(&text("key_ids_json")?)
        .map_err(|_| "invalid shared budget")?;
    let budget = Budget {
        id: text("id")?,
        tenant_id: text("tenant_id")?,
        name: text("name")?,
        max_microusd: integer("max_microusd")?,
        reservation_microusd: integer("reservation_microusd")?,
        duration: text("duration")?,
        enabled: match integer("enabled")? {
            0 => false,
            1 => true,
            _ => return Err("invalid shared budget"),
        },
        key_ids,
        revision: integer("revision")?,
    };
    validate_budget(&budget)?;
    Ok(budget)
}

fn validate_budget(budget: &Budget) -> Result<(), &'static str> {
    validate_id(&budget.id)?;
    validate_id(&budget.tenant_id)?;
    if budget.name.trim().is_empty()
        || budget.name.len() > 128
        || budget.name.chars().any(char::is_control)
        || !(1..=MAX_SAFE_INTEGER).contains(&budget.max_microusd)
        || !(1..=budget.max_microusd).contains(&budget.reservation_microusd)
        || !matches!(budget.duration.as_str(), "daily" | "monthly" | "total")
        || budget.key_ids.len() > 1_000
        || budget.key_ids.iter().any(|id| validate_id(id).is_err())
        || budget.revision < 0
    {
        return Err("invalid shared budget");
    }
    Ok(())
}

fn validate_input(mut input: BudgetInput) -> Result<BudgetInput, &'static str> {
    input.name = input.name.trim().to_owned();
    input.key_ids.sort();
    input.key_ids.dedup();
    let budget = Budget {
        id: "validation".to_owned(),
        tenant_id: "validation".to_owned(),
        name: input.name.clone(),
        max_microusd: usd_to_micros(input.max_spend_usd)?,
        reservation_microusd: usd_to_micros(input.reservation_spend_usd)?,
        duration: input.duration.clone(),
        enabled: input.enabled,
        key_ids: input.key_ids.clone(),
        revision: 0,
    };
    validate_budget(&budget)?;
    Ok(input)
}

fn applies(budget: &Budget, key_id: &str) -> bool {
    budget.key_ids.is_empty() || budget.key_ids.iter().any(|candidate| candidate == key_id)
}

async fn ledger_total(
    connection: &mut PoolConnection<Any>,
    budget: &Budget,
    window_start: i64,
) -> Result<i64, &'static str> {
    let mut query = total_query(
        "redrouter_usage_ledger",
        "amount_microusd",
        budget,
        window_start,
    );
    query
        .build_query_scalar::<i64>()
        .fetch_one(&mut **connection)
        .await
        .map_err(|_| "shared budget ledger unavailable")
}

async fn reservation_total(
    connection: &mut PoolConnection<Any>,
    budget: &Budget,
    window_start: i64,
) -> Result<i64, &'static str> {
    let mut query = total_query(
        "redrouter_usage_reservations",
        "reserved_microusd",
        budget,
        window_start,
    );
    query
        .build_query_scalar::<i64>()
        .fetch_one(&mut **connection)
        .await
        .map_err(|_| "shared budget reservations unavailable")
}

async fn ledger_total_pool(
    pool: &sqlx::AnyPool,
    budget: &Budget,
    window_start: i64,
) -> Result<i64, &'static str> {
    let mut query = total_query(
        "redrouter_usage_ledger",
        "amount_microusd",
        budget,
        window_start,
    );
    query
        .build_query_scalar::<i64>()
        .fetch_one(pool)
        .await
        .map_err(|_| "shared budget ledger unavailable")
}

async fn reservation_total_pool(
    pool: &sqlx::AnyPool,
    budget: &Budget,
    window_start: i64,
) -> Result<i64, &'static str> {
    let mut query = total_query(
        "redrouter_usage_reservations",
        "reserved_microusd",
        budget,
        window_start,
    );
    query
        .build_query_scalar::<i64>()
        .fetch_one(pool)
        .await
        .map_err(|_| "shared budget reservations unavailable")
}

fn total_query<'a>(
    table: &'static str,
    amount: &'static str,
    budget: &'a Budget,
    window_start: i64,
) -> QueryBuilder<'a, Any> {
    let mut query = QueryBuilder::<Any>::new(format!(
        "SELECT COALESCE(SUM({amount}),0) FROM {table} WHERE tenant_id="
    ));
    query
        .push_bind(&budget.tenant_id)
        .push(" AND created_at_unix_ms >= ")
        .push_bind(window_start);
    if !budget.key_ids.is_empty() {
        query.push(" AND key_id IN (");
        let mut separated = query.separated(",");
        for key in &budget.key_ids {
            separated.push_bind(key);
        }
        separated.push_unseparated(")");
    }
    query
}

fn budget_window(duration: &str, now_ms: i64) -> Result<(i64, Option<i64>), &'static str> {
    match duration {
        "total" => Ok((0, None)),
        "daily" => {
            let start = now_ms.div_euclid(86_400_000) * 86_400_000;
            Ok((start, start.checked_add(86_400_000)))
        }
        "monthly" => {
            let now = OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms) * 1_000_000)
                .map_err(|_| "invalid shared budget timestamp")?;
            let start = Date::from_calendar_date(now.year(), now.month(), 1)
                .map_err(|_| "invalid shared budget timestamp")?
                .with_time(Time::MIDNIGHT)
                .assume_utc();
            let (year, month) = if now.month() == Month::December {
                (now.year() + 1, Month::January)
            } else {
                (now.year(), now.month().next())
            };
            let next = Date::from_calendar_date(year, month, 1)
                .map_err(|_| "invalid shared budget timestamp")?
                .with_time(Time::MIDNIGHT)
                .assume_utc();
            Ok((to_millis(start)?, Some(to_millis(next)?)))
        }
        _ => Err("invalid shared budget duration"),
    }
}

fn to_millis(value: OffsetDateTime) -> Result<i64, &'static str> {
    i64::try_from(value.unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| "invalid shared budget timestamp")
}

fn usd_to_micros(value: f64) -> Result<i64, &'static str> {
    let micros = value * 1_000_000.0;
    if !value.is_finite() || value <= 0.0 || micros > MAX_SAFE_INTEGER as f64 {
        return Err("invalid shared budget amount");
    }
    Ok(micros.ceil() as i64)
}

fn micros_to_usd(value: i64) -> f64 {
    value as f64 / 1_000_000.0
}

fn validate_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid shared budget identifier");
    }
    Ok(())
}

fn now_ms() -> Result<i64, &'static str> {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "system clock unavailable")?
            .as_millis(),
    )
    .map_err(|_| "system clock unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        native_usage::{NativeQuota, NativeUsage, Reservation},
        storage::Backend,
    };
    use tempfile::TempDir;

    fn sqlite_url(folder: &TempDir) -> String {
        format!(
            "sqlite://{}?mode=rwc",
            folder.path().join("budget.sqlite").display()
        )
    }

    #[test]
    fn monthly_window_crosses_year_boundary() {
        let now = OffsetDateTime::from_unix_timestamp(1_765_756_800).unwrap();
        let (start, next) = budget_window("monthly", to_millis(now).unwrap()).unwrap();
        let start = OffsetDateTime::from_unix_timestamp(start / 1_000).unwrap();
        let next = OffsetDateTime::from_unix_timestamp(next.unwrap() / 1_000).unwrap();
        assert_eq!(
            (start.year(), start.month(), start.day()),
            (2025, Month::December, 1)
        );
        assert_eq!(
            (next.year(), next.month(), next.day()),
            (2026, Month::January, 1)
        );
    }

    #[test]
    fn normalizes_key_assignments() {
        let input = validate_input(BudgetInput {
            tenant_id: None,
            name: " Shared ".to_owned(),
            max_spend_usd: 10.0,
            reservation_spend_usd: 0.1,
            duration: "daily".to_owned(),
            enabled: true,
            key_ids: vec!["key-b".to_owned(), "key-a".to_owned(), "key-a".to_owned()],
        })
        .unwrap();
        assert_eq!(input.name, "Shared");
        assert_eq!(input.key_ids, vec!["key-a", "key-b"]);
    }

    #[tokio::test]
    async fn shared_budget_serializes_holds_across_proxy_instances() {
        let folder = TempDir::new().unwrap();
        let url = sqlite_url(&folder);
        let first = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        let second = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        upsert(
            &first,
            "budget-team",
            "tenant",
            BudgetInput {
                tenant_id: Some("tenant".to_owned()),
                name: "Team".to_owned(),
                max_spend_usd: 1.0,
                reservation_spend_usd: 0.6,
                duration: "daily".to_owned(),
                enabled: true,
                key_ids: Vec::new(),
            },
            1,
        )
        .await
        .unwrap();
        let one = NativeUsage::new(first.clone()).unwrap();
        let two = NativeUsage::new(second).unwrap();
        let quota = NativeQuota {
            max_tokens_per_minute: 0,
            max_tokens_per_day: 0,
            max_monthly_microusd: 0,
            reservation_tokens: 0,
            reservation_microusd: 0,
        };
        let first_hold = Reservation {
            event_id: "one",
            key_id: "key-a",
            tenant_id: "tenant",
            provider: "openai",
            model: "gpt",
            quota,
            reserved_tokens: 0,
            reserved_microusd: 600_000,
            now_ms: 1_700_000_000_000,
        };
        let second_hold = Reservation {
            event_id: "two",
            key_id: "key-b",
            tenant_id: "tenant",
            provider: "openai",
            model: "gpt",
            quota,
            reserved_tokens: 0,
            reserved_microusd: 600_000,
            now_ms: 1_700_000_000_000,
        };
        let (left, right) = tokio::join!(one.reserve(&first_hold), two.reserve(&second_hold));
        assert_ne!(left.unwrap(), right.unwrap());
        let views = list(&first, Some("tenant"), 1_700_000_000_000)
            .await
            .unwrap();
        assert_eq!(views[0].reserved_usd, 0.6);
    }
}
