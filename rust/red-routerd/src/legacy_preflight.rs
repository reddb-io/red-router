//! Read-only inventory for planning a legacy SQLite migration.
//!
//! This is deliberately not an importer or a parity verdict. Counts are taken
//! from a single snapshot and never include row contents or credentials.
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::path::Path;

const TABLES: &[&str] = &[
    "provider_connections",
    "provider_nodes",
    "api_keys",
    "combos",
    "redrouter_usage_sinks",
    "redrouter_usage_deliveries",
    "usage_history",
    "request_cost_ledger",
    "api_key_quota_limits",
    "api_key_token_limits",
    "api_key_daily_token_limits",
    "domain_budgets",
    "budget_assignments",
    "key_groups",
    "key_group_members",
];

#[derive(Debug, serde::Serialize)]
pub struct LegacyTableCount {
    pub table: &'static str,
    pub rows: Option<i64>,
}

#[derive(Debug, serde::Serialize)]
pub struct LegacyPreflight {
    pub version: u8,
    pub migration_ready: bool,
    pub pricing_rows: Option<i64>,
    pub tables: Vec<LegacyTableCount>,
}

pub async fn inspect(path: &Path) -> Result<LegacyPreflight, &'static str> {
    let options = SqliteConnectOptions::new().filename(path).read_only(true);
    let mut db = SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| "cannot open legacy SQLite database read-only")?;
    sqlx::query("PRAGMA query_only = ON")
        .execute(&mut db)
        .await
        .map_err(|_| "cannot initialize legacy inspection")?;
    let mut transaction = db
        .begin()
        .await
        .map_err(|_| "cannot inspect legacy database")?;
    let mut tables = Vec::with_capacity(TABLES.len());
    for &table in TABLES {
        let present: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .bind(table)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|_| "cannot inspect legacy schema")?;
        let rows = if present == 1 {
            // The table name comes exclusively from the fixed list above.
            Some(
                sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM \"{table}\""))
                    .fetch_one(&mut *transaction)
                    .await
                    .map_err(|_| "cannot count legacy data")?,
            )
        } else {
            None
        };
        tables.push(LegacyTableCount { table, rows });
    }
    let has_key_value: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'key_value'",
    )
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| "cannot inspect legacy schema")?;
    let pricing_rows = if has_key_value == 1 {
        Some(sqlx::query_scalar("SELECT COUNT(*) FROM key_value WHERE namespace IN ('pricing','pricing_synced','models_dev_pricing')")
            .fetch_one(&mut *transaction)
            .await
            .map_err(|_| "cannot inspect legacy pricing")?)
    } else {
        None
    };
    transaction
        .commit()
        .await
        .map_err(|_| "cannot finish legacy inspection")?;
    Ok(LegacyPreflight {
        version: 1,
        migration_ready: false,
        pricing_rows,
        tables,
    })
}
