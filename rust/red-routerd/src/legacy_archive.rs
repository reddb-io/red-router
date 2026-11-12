//! Offline, lossless staging of legacy usage, quota and budget tables.
//! Archived ledger rows have a separate read-only report; they are never used
//! by native quota admission or native usage exports.
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
            if table == "request_cost_ledger" && names.iter().any(|name| name == "tenant_id") && names.iter().any(|name| name == "api_key_id") {
                for (suffix, fields) in [("tenant", "tenant_id,__legacy_rowid DESC"), ("key", "api_key_id,__legacy_rowid DESC"), ("tenant_key", "tenant_id,api_key_id,__legacy_rowid DESC")] {
                    sqlx::query(&format!("CREATE INDEX {} ON {} ({fields})", ident(&format!("{dest}_{suffix}")), ident(&dest)))
                        .execute(&mut *tx).await.map_err(|_| "cannot index legacy usage")?;
                }
            }
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

#[derive(Debug, serde::Serialize)]
pub struct LegacyUsageEntry {
    pub row_id: String,
    pub key_id: String,
    pub tenant_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub timestamp: String,
    pub tokens_input: String,
    pub tokens_output: String,
    pub tokens_reasoning: String,
    pub amount_usd: f64,
    pub pricing_known: bool,
    pub success: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct LegacyUsagePage {
    pub available: bool,
    pub entries: Vec<LegacyUsageEntry>,
    pub next_cursor: Option<String>,
}

/// Read only the cost ledger. Tenant-bound callers can never receive rows with
/// another or unknown tenant; only a global administrator can see unknowns.
pub async fn usage_page(
    database: &crate::storage::Database,
    tenant: Option<&str>,
    key: Option<&str>,
    cursor: Option<i64>,
    limit: i64,
) -> Result<LegacyUsagePage, &'static str> {
    if !(1..=100).contains(&limit)
        || key.is_some_and(|value| {
            value.is_empty() || value.len() > 128 || value.chars().any(char::is_control)
        })
    {
        return Err("invalid legacy usage query");
    }
    if !database.is_sqlite().await {
        return Err("legacy usage unavailable");
    }
    let pool = database.sql_pool().ok_or("legacy usage unavailable")?;
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='redrouter_legacy_request_cost_ledger'")
        .fetch_one(pool).await.map_err(|_| "legacy usage unavailable")?;
    if exists == 0 {
        return Ok(LegacyUsagePage {
            available: false,
            entries: Vec::new(),
            next_cursor: None,
        });
    }
    let mut query = sqlx::QueryBuilder::<sqlx::Any>::new("SELECT __legacy_rowid,api_key_id,tenant_id,provider,model,timestamp,tokens_input,tokens_output,tokens_reasoning,amount_usd,pricing_known,success FROM main.redrouter_legacy_request_cost_ledger WHERE 1=1");
    if let Some(tenant) = tenant {
        query.push(" AND tenant_id = ").push_bind(tenant);
    }
    if let Some(key) = key {
        query.push(" AND api_key_id = ").push_bind(key);
    }
    if let Some(cursor) = cursor {
        query.push(" AND __legacy_rowid < ").push_bind(cursor);
    }
    query
        .push(" ORDER BY __legacy_rowid DESC LIMIT ")
        .push_bind(limit + 1);
    let rows = query
        .build()
        .fetch_all(pool)
        .await
        .map_err(|_| "legacy usage unavailable")?;
    let more = rows.len() > limit as usize;
    let mut entries = Vec::with_capacity(rows.len().min(limit as usize));
    for row in rows.iter().take(limit as usize) {
        let integer = |name| {
            row.try_get::<i64, _>(name)
                .map_err(|_| "invalid legacy usage")
        };
        let text = |name| {
            row.try_get::<String, _>(name)
                .map_err(|_| "invalid legacy usage")
        };
        let amount: f64 = row
            .try_get("amount_usd")
            .map_err(|_| "invalid legacy usage")?;
        let pricing = integer("pricing_known")?;
        let success = integer("success")?;
        if !amount.is_finite() || !matches!(pricing, 0 | 1) || !matches!(success, 0 | 1) {
            return Err("invalid legacy usage");
        }
        entries.push(LegacyUsageEntry {
            row_id: integer("__legacy_rowid")?.to_string(),
            key_id: text("api_key_id")?,
            tenant_id: row
                .try_get("tenant_id")
                .map_err(|_| "invalid legacy usage")?,
            provider: text("provider")?,
            model: text("model")?,
            timestamp: text("timestamp")?,
            tokens_input: integer("tokens_input")?.to_string(),
            tokens_output: integer("tokens_output")?.to_string(),
            tokens_reasoning: integer("tokens_reasoning")?.to_string(),
            amount_usd: amount,
            pricing_known: pricing == 1,
            success: success == 1,
        });
    }
    let next_cursor = if more {
        entries.last().map(|entry| entry.row_id.clone())
    } else {
        None
    };
    Ok(LegacyUsagePage {
        available: true,
        entries,
        next_cursor,
    })
}
