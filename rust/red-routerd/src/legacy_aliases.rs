//! Strict offline import of legacy exact model aliases.
//!
//! The first supported slice is OpenAI aliases explicitly set in the legacy
//! database or Settings. Other destinations and managed or wildcard aliases
//! must be migrated separately; refusing them avoids silently changing routes.
use crate::{control_plane::model_aliases, storage::StoredModelAlias};
use futures_util::TryStreamExt;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
};

#[derive(Debug, serde::Serialize)]
pub struct AliasImport {
    pub imported: u64,
    pub already_present: u64,
}

pub async fn import(source: &Path, destination: &Path) -> Result<AliasImport, &'static str> {
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
        sqlx::query("PRAGMA query_only = ON").execute(&mut input).await.map_err(|_| "cannot initialize legacy database")?;
        sqlx::query("PRAGMA trusted_schema = OFF").execute(&mut input).await.map_err(|_| "cannot initialize legacy database")?;
        let mut snapshot = input.begin().await.map_err(|_| "cannot read legacy aliases")?;
        let mut target = output.begin_with("BEGIN IMMEDIATE").await.map_err(|_| "cannot start alias import")?;
        let inner: Result<AliasImport, &'static str> = async {
            let mixed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='provider_connections'").fetch_one(&mut *target).await.map_err(|_| "cannot inspect destination")?;
            if mixed != 0 { return Err("destination contains legacy tables; use a separate Rust database"); }
            let mut rows = sqlx::query("SELECT namespace,key,value FROM key_value WHERE namespace IN ('modelAliases','managedModelAliasNames','providerAliases') OR (namespace='settings' AND key IN ('modelAliases','wildcardAliases')) ORDER BY namespace,key").fetch(&mut *snapshot);
            let mut row_count = 0_usize;
            let mut aliases = BTreeMap::new();
            let mut settings = None;
            let mut managed = HashSet::new();
            let mut bytes = 0_usize;
            while let Some(row) = rows.try_next().await.map_err(|_| "cannot read legacy aliases")? {
                row_count += 1;
                if row_count > 10003 { return Err("too many legacy aliases"); }
                let namespace: String = row.try_get("namespace").map_err(|_| "invalid legacy alias")?;
                let key: String = row.try_get("key").map_err(|_| "invalid legacy alias")?;
                let raw: String = row.try_get("value").map_err(|_| "invalid legacy alias")?;
                bytes = bytes.checked_add(key.len()).and_then(|n| n.checked_add(raw.len())).ok_or("legacy aliases too large")?;
                if bytes > 8 * 1024 * 1024 { return Err("legacy aliases too large"); }
                let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| "invalid legacy alias configuration")?;
                match (namespace.as_str(),key.as_str()) {
                    ("modelAliases", _) => { if aliases.insert(key, value).is_some() { return Err("duplicate legacy alias"); } }
                    ("settings", "modelAliases") => { if settings.replace(value).is_some() { return Err("duplicate settings aliases"); } }
                    ("settings", "wildcardAliases") => if value.as_array().is_none_or(|items| !items.is_empty()) && !value.is_null() { return Err("legacy wildcard aliases require migration"); },
                    ("providerAliases", _) => {
                        if value.as_object().is_none_or(|aliases| !aliases.is_empty()) {
                            return Err("provider-scoped aliases require migration");
                        }
                    }
                    ("managedModelAliasNames", "names") => {
                        let names = value.as_array().ok_or("invalid managed alias names")?;
                        for name in names { managed.insert(name.as_str().ok_or("invalid managed alias name")?.to_owned()); }
                    }
                    ("managedModelAliasNames", _) => return Err("unsupported managed alias configuration"),
                    _ => return Err("unsupported legacy alias configuration"),
                }
            }
            drop(rows);
            if let Some(settings) = settings.filter(|settings| !settings.is_null()) {
                let settings = settings.as_object().ok_or("invalid settings aliases")?;
                for (key,value) in settings { aliases.insert(key.clone(), value.clone()); }
            }
            if aliases.len() > 10_000 { return Err("too many legacy aliases"); }
            if !managed.is_empty() { return Err("managed aliases require migration"); }
            let tenant_exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_tenants WHERE id='red' AND enabled=1").fetch_one(&mut *target).await.map_err(|_| "destination tenant unavailable")?;
            if tenant_exists != 1 { return Err("destination tenant unavailable"); }
            let mut imported = 0;
            let mut already_present = 0;
            for (alias,value) in aliases {
                let model = value.as_str().and_then(|v| v.strip_prefix("openai/")).ok_or("legacy alias destination requires migration")?;
                let record = StoredModelAlias { id: model_aliases::record_id("red", &alias), tenant_id: "red".into(), provider: "openai".into(), alias, model: model.into(), protocol: "openai".into(), enabled: true, revision: 1 };
                model_aliases::validate(&record)?;
                if record.alias.contains(['*','?']) { return Err("legacy wildcard aliases require migration"); }
                let collision: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_combos WHERE id IN (?,?)").bind(&record.id).bind(&record.alias).fetch_one(&mut *target).await.map_err(|_| "cannot inspect destination combos")?;
                if collision != 0 { return Err("legacy alias conflicts with destination combo"); }
                let namespace = serde_json::to_string(&(&record.tenant_id,&record.alias)).map_err(|_| "invalid alias identity")?;
                let document = serde_json::to_string(&record).map_err(|_| "invalid legacy alias")?;
                let inserted = sqlx::query("INSERT INTO redrouter_control_model_aliases (id,tenant_id,namespace,config_json,revision) VALUES (?,?,?,?,1) ON CONFLICT DO NOTHING").bind(&record.id).bind(&record.tenant_id).bind(&namespace).bind(&document).execute(&mut *target).await.map_err(|_| "cannot import alias")?.rows_affected();
                if inserted == 1 { imported += 1; } else {
                    let existing: Option<String> = sqlx::query_scalar("SELECT config_json FROM redrouter_control_model_aliases WHERE id=? AND tenant_id=? AND namespace=?").bind(&record.id).bind(&record.tenant_id).bind(&namespace).fetch_optional(&mut *target).await.map_err(|_| "cannot verify alias")?;
                    if existing.as_deref() != Some(&document) { return Err("destination contains conflicting alias"); }
                    already_present += 1;
                }
            }
            if imported + already_present > 0 {
                sqlx::query("INSERT INTO redrouter_model_alias_state (id) VALUES ('configured') ON CONFLICT (id) DO NOTHING").execute(&mut *target).await.map_err(|_| "cannot persist alias routing state")?;
            }
            Ok(AliasImport { imported, already_present })
        }.await;
        match inner {
            Ok(report) => {
                snapshot.commit().await.map_err(|_| "cannot finish legacy alias snapshot")?;
                target.commit().await.map_err(|_| "cannot commit alias import")?;
                Ok(report)
            }
            Err(error) => { let _ = target.rollback().await; let _ = snapshot.rollback().await; Err(error) }
        }
    }.await;
    let output_close = output.close().await;
    let input_close = input.close().await;
    if output_close.is_err() || input_close.is_err() {
        return Err("cannot close migration database");
    }
    result
}
