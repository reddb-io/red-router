//! Read-only inventory for planning a legacy SQLite migration.
//!
//! Inspection is not a parity verdict. Counts come from a single snapshot and
//! never include row contents or credentials. Pricing import is a separate,
//! explicitly selected operation that never overwrites destination values.
use futures_util::TryStreamExt;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
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

// Each row can contain a JSON array or map, so these are namespace row counts,
// not counts of individual models or a claim that they can already be migrated.
const MODEL_NAMESPACES: &[&str] = &[
    "customModels",
    "syncedAvailableModels",
    "modelAliases",
    "providerAliases",
    "managedModelAliasNames",
    "modelCompatOverrides",
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
    pub model_namespaces: Vec<LegacyNamespaceCount>,
    pub tables: Vec<LegacyTableCount>,
}

#[derive(Debug, serde::Serialize)]
pub struct LegacyNamespaceCount {
    pub namespace: &'static str,
    pub rows: Option<i64>,
}

#[derive(Debug, serde::Serialize)]
pub struct PricingImport {
    pub inserted: u64,
    pub already_present: u64,
}

/// Copy only the three legacy pricing namespaces. Existing values are never
/// overwritten; any conflicting value rolls back the entire destination write.
pub async fn import_pricing(
    source: &Path,
    destination: &Path,
) -> Result<PricingImport, &'static str> {
    let source_path =
        std::fs::canonicalize(source).map_err(|_| "legacy database does not exist")?;
    let destination_path =
        std::fs::canonicalize(destination).map_err(|_| "destination database does not exist")?;
    if source_path == destination_path {
        return Err("legacy and destination databases must be different files");
    }
    let mut input = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(source_path)
            .read_only(true),
    )
    .await
    .map_err(|_| "cannot open legacy SQLite database read-only")?;
    sqlx::query("PRAGMA query_only = ON")
        .execute(&mut input)
        .await
        .map_err(|_| "cannot initialize legacy inspection")?;
    let mut output =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(destination_path))
            .await
            .map_err(|_| "cannot open destination SQLite database")?;
    let result = async {
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut output)
        .await
        .map_err(|_| "cannot initialize destination database")?;
    let mut snapshot = input
        .begin()
        .await
        .map_err(|_| "cannot inspect legacy pricing")?;
    let mut target = output
        .begin()
        .await
        .map_err(|_| "cannot start pricing import")?;
    let result: Result<PricingImport, &'static str> = async {
    let mut rows = sqlx::query("SELECT namespace,key,value FROM key_value WHERE namespace IN ('pricing','pricing_synced','models_dev_pricing') ORDER BY namespace,key")
        .fetch(&mut *snapshot);
    let mut inserted = 0u64;
    let mut already_present = 0u64;
    let mut total_bytes = 0usize;
    while let Some(row) = rows
        .try_next()
        .await
        .map_err(|_| "cannot read legacy pricing")?
    {
        if inserted + already_present >= 10_000 {
            return Err("legacy pricing has too many rows");
        }
        let namespace: String = row
            .try_get("namespace")
            .map_err(|_| "invalid legacy pricing row")?;
        let key: String = row
            .try_get("key")
            .map_err(|_| "invalid legacy pricing row")?;
        let value: String = row
            .try_get("value")
            .map_err(|_| "invalid legacy pricing row")?;
        if key.is_empty() || key.len() > 512 || value.len() > 16 * 1024 * 1024 {
            return Err("invalid legacy pricing row");
        }
        total_bytes = total_bytes
            .checked_add(value.len())
            .ok_or("legacy pricing is too large")?;
        if total_bytes > 64 * 1024 * 1024 {
            return Err("legacy pricing is too large");
        }
        let changed = sqlx::query("INSERT INTO key_value (namespace,key,value) VALUES (?,?,?) ON CONFLICT(namespace,key) DO NOTHING")
            .bind(&namespace).bind(&key).bind(&value).execute(&mut *target).await
            .map_err(|_| "cannot write destination pricing")?.rows_affected();
        if changed == 1 {
            inserted += 1;
        } else {
            let existing: String =
                sqlx::query_scalar("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
                    .bind(&namespace)
                    .bind(&key)
                    .fetch_one(&mut *target)
                    .await
                    .map_err(|_| "cannot verify destination pricing")?;
            if existing != value {
                return Err("destination contains conflicting pricing; no rows imported");
            }
            already_present += 1;
        }
    }
    Ok(PricingImport {
        inserted,
        already_present,
    })
    }.await;
    match result {
        Ok(report) => {
            if snapshot.commit().await.is_err() {
                let _ = target.rollback().await;
                return Err("cannot finish legacy inspection");
            }
            target
                .commit()
                .await
                .map_err(|_| "cannot commit pricing import")?;
            Ok(report)
        }
        Err(error) => {
            let _ = target.rollback().await;
            let _ = snapshot.rollback().await;
            Err(error)
        }
    }
    }.await;
    let output_close = output.close().await;
    let input_close = input.close().await;
    if output_close.is_err() || input_close.is_err() {
        return Err("cannot close migration database");
    }
    result
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
    let mut model_namespaces = Vec::with_capacity(MODEL_NAMESPACES.len());
    for &namespace in MODEL_NAMESPACES {
        let rows = if has_key_value == 1 {
            Some(
                sqlx::query_scalar("SELECT COUNT(*) FROM key_value WHERE namespace = ?")
                    .bind(namespace)
                    .fetch_one(&mut *transaction)
                    .await
                    .map_err(|_| "cannot inspect legacy model configuration")?,
            )
        } else {
            None
        };
        model_namespaces.push(LegacyNamespaceCount { namespace, rows });
    }
    transaction
        .commit()
        .await
        .map_err(|_| "cannot finish legacy inspection")?;
    Ok(LegacyPreflight {
        version: 2,
        migration_ready: false,
        pricing_rows,
        model_namespaces,
        tables,
    })
}
