//! Offline import of the subset of legacy custom models with native equivalents.
//! Any unsupported behavior rolls back the entire import.
use crate::{catalog::ModelMetadata, control_plane::provider_models, storage::StoredProviderModel};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{collections::HashSet, path::Path};

#[derive(Debug, serde::Serialize)]
pub struct ModelImport {
    pub imported: u64,
    pub already_present: u64,
}

pub async fn import(source: &Path, destination: &Path) -> Result<ModelImport, &'static str> {
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
    for statement in ["PRAGMA query_only = ON", "PRAGMA trusted_schema = OFF"] {
        sqlx::query(statement)
            .execute(&mut input)
            .await
            .map_err(|_| "cannot initialize legacy database")?;
    }
    let mut output = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(destination)
            .busy_timeout(std::time::Duration::from_secs(5)),
    )
    .await
    .map_err(|_| "cannot open destination database")?;
    let mut snapshot = input
        .begin()
        .await
        .map_err(|_| "cannot read legacy models")?;
    let mut target = output
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|_| "cannot start model import")?;
    let result: Result<ModelImport, &'static str> = async {
        let mixed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='provider_connections'").fetch_one(&mut *target).await.map_err(|_| "cannot inspect destination")?;
        if mixed != 0 { return Err("destination contains legacy tables; use a separate Rust database"); }
        let red: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_tenants WHERE id='red' AND enabled=1").fetch_one(&mut *target).await.map_err(|_| "destination tenant unavailable")?;
        if red != 1 { return Err("destination tenant unavailable"); }
        let rows = sqlx::query("SELECT key,value FROM key_value WHERE namespace='customModels' ORDER BY key").fetch_all(&mut *snapshot).await.map_err(|_| "legacy model schema unavailable")?;
        if rows.len() > 10_000 { return Err("too many legacy model rows"); }
        let mut seen = HashSet::new();
        let mut imported = 0_u64;
        let mut already_present = 0_u64;
        let mut bytes = 0_usize;
        for row in rows {
            let provider: String = row.try_get("key").map_err(|_| "invalid legacy model provider")?;
            // Custom node IDs need explicit identity resolution, not a guessed prefix.
            crate::control_plane::validate_provider(&provider)?;
            let node: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_provider_nodes WHERE id=? AND tenant_id='red'")
                .bind(&provider).fetch_one(&mut *target).await.map_err(|_| "destination provider definitions unavailable")?;
            if node != 0 { return Err("legacy custom provider model identity requires migration"); }
            let value: String = row.try_get("value").map_err(|_| "invalid legacy models")?;
            bytes = bytes.checked_add(value.len()).ok_or("legacy models too large")?;
            if bytes > 8 * 1024 * 1024 { return Err("legacy models too large"); }
            let models: Vec<serde_json::Value> = serde_json::from_str(&value).map_err(|_| "invalid legacy models")?;
            for item in models {
                if seen.len() >= 10_000 { return Err("too many legacy models"); }
                let object = item.as_object().ok_or("invalid legacy model")?;
                if object.keys().any(|key| !matches!(key.as_str(), "id" | "name" | "source" | "apiFormat" | "supportedEndpoints" | "inputTokenLimit" | "outputTokenLimit" | "supportsThinking")) {
                    return Err("legacy model settings require migration");
                }
                if object.get("source").is_some_and(|v| v.as_str() != Some("manual"))
                    || object.get("apiFormat").is_some_and(|v| v.as_str() != Some("chat-completions"))
                    || object.get("supportedEndpoints").is_some_and(|v| v != &serde_json::json!(["chat"])) {
                    return Err("legacy model routing or provenance requires migration");
                }
                let id = object.get("id").and_then(|v| v.as_str()).ok_or("invalid legacy model")?;
                let name = match object.get("name") { None | Some(serde_json::Value::Null) => id, Some(value) => value.as_str().ok_or("invalid legacy model name")? };
                let name = if name.is_empty() { id } else { name };
                let number = |field: &str| -> Result<Option<u64>, &'static str> {
                    match object.get(field) { None | Some(serde_json::Value::Null) => Ok(None), Some(value) => value.as_u64().map(Some).ok_or("invalid legacy model token limit") }
                };
                let input = number("inputTokenLimit")?;
                let output = number("outputTokenLimit")?;
                let reasoning = match object.get("supportsThinking") { None | Some(serde_json::Value::Null) => None, Some(value) => Some(value.as_bool().ok_or("invalid legacy model capability")?) };
                let mut metadata: ModelMetadata = serde_json::from_value(serde_json::json!({"id":id,"name":name,"reasoning":reasoning})).map_err(|_| "invalid legacy model")?;
                if input.is_some() || output.is_some() { metadata.limit = Some(crate::catalog::CatalogLimit { context: None, input, output }); }
                provider_models::validate_metadata(&metadata)?;
                let identity = provider_models::record_id("red", &provider, id);
                if !seen.insert(identity.clone()) { return Err("duplicate legacy model"); }
                let record = StoredProviderModel { id: identity.clone(), tenant_id: "red".to_owned(), provider: provider.clone(), metadata, revision: 1 };
                let namespace = serde_json::to_string(&(&record.tenant_id, &record.provider, &record.metadata.id)).map_err(|_| "invalid model identity")?;
                let document = serde_json::to_string(&record).map_err(|_| "invalid legacy model")?;
                let inserted = sqlx::query("INSERT INTO redrouter_control_provider_models (id,tenant_id,namespace,config_json,revision) VALUES (?,?,?,?,1) ON CONFLICT DO NOTHING").bind(&identity).bind("red").bind(&namespace).bind(&document).execute(&mut *target).await.map_err(|_| "cannot import model")?.rows_affected();
                if inserted == 1 { imported += 1; } else {
                    let existing: Option<String> = sqlx::query_scalar("SELECT config_json FROM redrouter_control_provider_models WHERE id=? AND tenant_id='red' AND namespace=?").bind(&identity).bind(&namespace).fetch_optional(&mut *target).await.map_err(|_| "cannot verify model")?;
                    if existing.as_deref() != Some(&document) { return Err("destination contains conflicting model"); }
                    already_present += 1;
                }
            }
        }
        Ok(ModelImport { imported, already_present })
    }.await;
    match result {
        Ok(report) => {
            snapshot
                .commit()
                .await
                .map_err(|_| "cannot finish legacy model snapshot")?;
            target
                .commit()
                .await
                .map_err(|_| "cannot commit model import")?;
            Ok(report)
        }
        Err(error) => {
            let _ = target.rollback().await;
            let _ = snapshot.rollback().await;
            Err(error)
        }
    }
}
