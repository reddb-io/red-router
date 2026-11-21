//! Offline import of the legacy operator payload rules (`settings.payloadRules`).
//!
//! The legacy server reads the database copy first, so it is the one migrated;
//! a rules file used only when the database had none is outside the database
//! and is not seen here. Invalid entries are dropped exactly as the legacy
//! `normalizePayloadRulesConfig` drops them at runtime.
use crate::payload_rules::normalize_payload_rules_config;
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::path::Path;

#[derive(Debug, serde::Serialize)]
pub struct PayloadRulesImport {
    /// Whether the legacy database carried rules with any effect.
    pub found: bool,
    pub imported: bool,
    pub already_present: bool,
}

pub async fn import(source: &Path, destination: &Path) -> Result<PayloadRulesImport, &'static str> {
    let source = std::fs::canonicalize(source).map_err(|_| "legacy database does not exist")?;
    let destination =
        std::fs::canonicalize(destination).map_err(|_| "destination database does not exist")?;
    if source == destination {
        return Err("legacy and destination databases must be different files");
    }
    let mut input = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(source).read_only(true),
    )
    .await
    .map_err(|_| "cannot open legacy database read-only")?;
    let mut output = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(destination)
            .busy_timeout(std::time::Duration::from_secs(5)),
    )
    .await
    .map_err(|_| "cannot open destination database")?;
    let result = async {
        for statement in ["PRAGMA query_only = ON", "PRAGMA trusted_schema = OFF"] {
            sqlx::query(statement)
                .execute(&mut input)
                .await
                .map_err(|_| "cannot initialize legacy database")?;
        }
        let has_settings: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='key_value'",
        )
        .fetch_one(&mut input)
        .await
        .map_err(|_| "cannot inspect legacy settings")?;
        let raw: Option<Option<String>> = if has_settings == 0 {
            None
        } else {
            sqlx::query_scalar(
                "SELECT value FROM key_value WHERE namespace='settings' AND key='payloadRules'",
            )
            .fetch_optional(&mut input)
            .await
            .map_err(|_| "cannot read legacy payload rules")?
        };
        let Some(raw) = raw.flatten() else {
            return Ok(PayloadRulesImport { found: false, imported: false, already_present: false });
        };
        if raw.len() > 1024 * 1024 {
            return Err("legacy payload rules too large");
        }
        let value: serde_json::Value =
            serde_json::from_str(&raw).map_err(|_| "invalid legacy payload rules")?;
        let rules = normalize_payload_rules_config(&value);
        if rules.is_empty() {
            return Ok(PayloadRulesImport { found: false, imported: false, already_present: false });
        }
        let document = serde_json::to_string(&rules).map_err(|_| "invalid legacy payload rules")?;
        let mut target = output
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|_| "cannot start payload rules import")?;
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT config_json FROM redrouter_control_payload_rules WHERE id='global'",
        )
        .fetch_optional(&mut *target)
        .await
        .map_err(|_| "cannot inspect destination payload rules")?;
        let report = match existing {
            Some(existing) => {
                let existing: serde_json::Value = serde_json::from_str(&existing)
                    .map_err(|_| "invalid destination payload rules")?;
                if existing != serde_json::to_value(&rules).map_err(|_| "invalid legacy payload rules")? {
                    return Err("destination contains different payload rules");
                }
                PayloadRulesImport { found: true, imported: false, already_present: true }
            }
            None => {
                sqlx::query("INSERT INTO redrouter_control_payload_rules (id,config_json,revision) VALUES ('global',?,1)")
                    .bind(&document)
                    .execute(&mut *target)
                    .await
                    .map_err(|_| "cannot import payload rules")?;
                PayloadRulesImport { found: true, imported: true, already_present: false }
            }
        };
        target
            .commit()
            .await
            .map_err(|_| "cannot commit payload rules import")?;
        Ok(report)
    }
    .await;
    let output_close = output.close().await;
    let input_close = input.close().await;
    if output_close.is_err() || input_close.is_err() {
        return Err("cannot close migration database");
    }
    result
}
