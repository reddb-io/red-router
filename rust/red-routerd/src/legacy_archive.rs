//! Offline, lossless staging of legacy usage, quota and budget tables.
//! These tables are not consulted by the native admission or reporting paths.
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::path::Path;
use url::Url;

const TABLES: &[&str] = &[
    "usage_history",
    "request_cost_ledger",
    "api_key_quota_limits",
    "api_key_quota_counters",
    "api_key_daily_token_limits",
    "api_key_token_limits",
    "api_key_token_counters",
    "api_key_usage_reservations",
    "domain_budgets",
    "budget_assignments",
    "budgets",
    "budget_windows",
    "budget_window_models",
    "key_groups",
    "key_group_members",
    "group_model_permissions",
    "cost_ledger_outbox",
    "redrouter_usage_deliveries",
];

#[derive(Debug, serde::Serialize)]
pub struct ArchivedTable {
    pub source: &'static str,
    pub rows: Option<i64>,
}
#[derive(Debug, serde::Serialize)]
pub struct ArchiveReport {
    pub tables: Vec<ArchivedTable>,
}

/// Attach the source read-only and copy complete rows into separate staging
/// tables. A snapshot with any unsupported schema or differing value rolls back
/// in full. Both services must remain stopped until the migration is complete.
pub async fn archive(source: &Path, destination: &Path) -> Result<ArchiveReport, &'static str> {
    let absolute = std::path::absolute(source).map_err(|_| "invalid legacy database path")?;
    let source_path =
        std::fs::canonicalize(&absolute).map_err(|_| "legacy database does not exist")?;
    let dest_path =
        std::fs::canonicalize(destination).map_err(|_| "destination database does not exist")?;
    if source_path == dest_path {
        return Err("legacy and destination databases must be different files");
    }
    let mut source_url =
        Url::from_file_path(&absolute).map_err(|_| "invalid legacy database path")?;
    source_url.query_pairs_mut().append_pair("mode", "ro");
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(dest_path))
        .await
        .map_err(|_| "cannot open destination SQLite database")?;
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut db)
        .await
        .map_err(|_| "cannot initialize destination database")?;
    sqlx::query("PRAGMA trusted_schema = OFF")
        .execute(&mut db)
        .await
        .map_err(|_| "cannot initialize destination database")?;
    sqlx::query("ATTACH DATABASE ? AS legacy")
        .bind(source_url.as_str())
        .execute(&mut db)
        .await
        .map_err(|_| "cannot attach legacy database read-only")?;
    let mut tx = db
        .begin()
        .await
        .map_err(|_| "cannot start legacy archive")?;
    let result: Result<ArchiveReport, &'static str> = async {
        // This also prevents a hard link from opening the source for writes as
        // the destination. Archive only into a separate Rust-owned database.
        let mixed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM main.sqlite_master WHERE type='table' AND name IN ('usage_history','request_cost_ledger')")
            .fetch_one(&mut *tx).await.map_err(|_| "cannot inspect destination schema")?;
        if mixed != 0 { return Err("destination contains legacy tables; use a separate Rust database"); }
        for required in ["usage_history", "request_cost_ledger"] {
            let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM legacy.sqlite_master WHERE type='table' AND name=?")
                .bind(required).fetch_one(&mut *tx).await.map_err(|_| "cannot inspect legacy schema")?;
            if exists != 1 { return Err("legacy usage schema is incomplete; nothing archived"); }
        }
        let marker: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM main.sqlite_master WHERE name='redrouter_legacy_archive_manifest'")
            .fetch_one(&mut *tx).await.map_err(|_| "cannot inspect archive state")?;
        if marker != 0 { return Err("legacy archive already exists; nothing overwritten"); }
        sqlx::query("CREATE TABLE redrouter_legacy_archive_manifest (source_table TEXT PRIMARY KEY, row_count BIGINT)")
            .execute(&mut *tx).await.map_err(|_| "cannot initialize legacy archive")?;
        let mut report = Vec::with_capacity(TABLES.len());
        for &table in TABLES {
            let definition: Option<String> = sqlx::query_scalar("SELECT sql FROM legacy.sqlite_master WHERE type='table' AND name=?")
                .bind(table).fetch_optional(&mut *tx).await.map_err(|_| "cannot inspect legacy schema")?;
            let Some(definition) = definition else {
                sqlx::query("INSERT INTO redrouter_legacy_archive_manifest VALUES (?,NULL)").bind(table).execute(&mut *tx).await.map_err(|_| "cannot write archive manifest")?;
                report.push(ArchivedTable { source: table, rows: None });
                continue;
            };
            if definition.to_ascii_uppercase().contains("VIRTUAL TABLE") || definition.to_ascii_uppercase().contains("WITHOUT ROWID") {
                return Err("unsupported legacy table; nothing archived");
            }
            let columns = sqlx::query(&format!("PRAGMA legacy.table_xinfo({})", ident(table)))
                .fetch_all(&mut *tx).await.map_err(|_| "cannot inspect legacy columns")?;
            if columns.is_empty() || columns.len() > 256 { return Err("unsupported legacy table; nothing archived"); }
            let mut names = Vec::with_capacity(columns.len());
            for column in columns {
                let name: String = column.try_get("name").map_err(|_| "invalid legacy schema")?;
                let hidden: i64 = column.try_get("hidden").map_err(|_| "invalid legacy schema")?;
                if hidden != 0 || name.is_empty() || name.len() > 256 || ["rowid", "_rowid_", "oid", "__legacy_rowid"].iter().any(|reserved| name.eq_ignore_ascii_case(reserved)) {
                    return Err("unsupported legacy column; nothing archived");
                }
                names.push(name);
            }
            let dest = format!("redrouter_legacy_{table}");
            let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM main.sqlite_master WHERE name=?")
                .bind(&dest).fetch_one(&mut *tx).await.map_err(|_| "cannot inspect archive state")?;
            if exists != 0 { return Err("legacy archive already exists; nothing overwritten"); }
            let source_table = format!("legacy.{}", ident(table));
            let target_table = format!("main.{}", ident(&dest));
            sqlx::query(&format!("CREATE TABLE {target_table} AS SELECT rowid AS __legacy_rowid, * FROM {source_table}"))
                .execute(&mut *tx).await.map_err(|_| "cannot copy legacy table")?;
            sqlx::query(&format!("CREATE UNIQUE INDEX {} ON {} (__legacy_rowid)", ident(&format!("{dest}_rowid")), ident(&dest)))
                .execute(&mut *tx).await.map_err(|_| "cannot index legacy archive")?;
            let source_count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {source_table}"))
                .fetch_one(&mut *tx).await.map_err(|_| "cannot verify legacy rows")?;
            let target_count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {target_table}"))
                .fetch_one(&mut *tx).await.map_err(|_| "cannot verify archived rows")?;
            if source_count != target_count { return Err("legacy archive verification failed"); }
            let differences = names.iter().map(|name| {
                let name = ident(name);
                format!("typeof(s.{name}) <> typeof(d.{name}) OR NOT (s.{name} COLLATE BINARY IS d.{name} COLLATE BINARY)")
            }).collect::<Vec<_>>().join(" OR ");
            let mismatch: i64 = sqlx::query_scalar(&format!("SELECT EXISTS(SELECT 1 FROM {source_table} s LEFT JOIN {target_table} d ON s.rowid=d.__legacy_rowid WHERE d.__legacy_rowid IS NULL OR {differences} LIMIT 1)"))
                .fetch_one(&mut *tx).await.map_err(|_| "cannot verify archived values")?;
            if mismatch != 0 { return Err("legacy archive verification failed"); }
            sqlx::query("INSERT INTO redrouter_legacy_archive_manifest VALUES (?,?)").bind(table).bind(source_count)
                .execute(&mut *tx).await.map_err(|_| "cannot write archive manifest")?;
            report.push(ArchivedTable { source: table, rows: Some(source_count) });
        }
        Ok(ArchiveReport { tables: report })
    }.await;
    match result {
        Ok(report) => {
            tx.commit()
                .await
                .map_err(|_| "cannot commit legacy archive")?;
            Ok(report)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

fn ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
