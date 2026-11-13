//! Lossless offline migration of reusable compatible-provider definitions.
//!
//! Definitions do not route traffic by themselves. Account credentials and
//! bindings are migrated separately and remain disabled until verified.
use crate::storage::StoredProviderNode;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
};

#[derive(Debug, serde::Serialize)]
pub struct ProviderNodeImport {
    pub imported: u64,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_prefix(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn reserved_prefix(value: &str) -> Result<bool, &'static str> {
    if matches!(value, "redrouter" | "gemini-cli")
        || crate::product_provider::chat_url(value).is_some()
    {
        return Ok(true);
    }
    let registry: serde_json::Value = serde_json::from_str(include_str!(
        "../../../config/upstream/legacy-executor-parity.json"
    ))
    .map_err(|_| "cannot read provider namespace registry")?;
    Ok(registry["groups"].as_array().is_some_and(|groups| {
        groups.iter().any(|group| {
            group["aliases"]
                .as_array()
                .is_some_and(|aliases| aliases.iter().any(|alias| alias.as_str() == Some(value)))
        })
    }))
}

fn protocol(
    node_type: &str,
    api_type: Option<&str>,
    id: &str,
) -> Result<&'static str, &'static str> {
    match node_type {
        "openai-compatible" => match api_type.filter(|value| !value.is_empty()).unwrap_or("chat") {
            "chat" => Ok("openai"),
            "responses" => Ok("openai-responses"),
            "embeddings" => Ok("openai-embeddings"),
            "rerank" => Ok("cohere-rerank"),
            _ => Err("legacy provider node protocol requires migration"),
        },
        "anthropic-compatible" if id.starts_with("claude-code-compatible-") => {
            Err("legacy Claude Code compatible node requires migration")
        }
        "anthropic-compatible" => Ok("anthropic"),
        _ => Err("legacy provider node type requires migration"),
    }
}

fn optional_column(columns: &HashSet<String>, name: &str) -> String {
    if columns.contains(name) {
        format!("\"{name}\"")
    } else {
        "NULL".to_owned()
    }
}

/// Import reusable definitions from a quiescent legacy SQLite database.
///
/// Unsupported fields fail the entire transaction instead of being dropped.
pub async fn import(
    source: &Path,
    destination: &Path,
    storage_key: &str,
) -> Result<ProviderNodeImport, &'static str> {
    if !(16..=512).contains(&storage_key.len()) {
        return Err("invalid storage encryption key");
    }
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
    let mut output =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(destination))
            .await
            .map_err(|_| "cannot open destination database")?;
    let result = async {
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut output)
        .await
        .map_err(|_| "cannot initialize destination database")?;
    let mut snapshot = input
        .begin()
        .await
        .map_err(|_| "cannot start legacy provider definition snapshot")?;
    let mut target = output
        .begin()
        .await
        .map_err(|_| "cannot start provider definition import")?;
    let result: Result<ProviderNodeImport, &'static str> = async {
        let mixed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='provider_nodes'")
            .fetch_one(&mut *target).await.map_err(|_| "cannot inspect destination schema")?;
        if mixed != 0 {
            return Err("destination contains legacy tables; use a separate Rust database");
        }
        let definition: Option<String> = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_nodes'",
        )
        .fetch_optional(&mut *snapshot)
        .await
        .map_err(|_| "cannot inspect legacy provider node schema")?;
        let definition = definition.ok_or("legacy provider node schema unavailable")?;
        if definition.to_ascii_uppercase().contains("VIRTUAL TABLE") {
            return Err("unsupported legacy provider node schema");
        }
        let schema = sqlx::query("PRAGMA table_xinfo('provider_nodes')")
            .fetch_all(&mut *snapshot)
            .await
            .map_err(|_| "cannot inspect legacy provider node schema")?;
        if schema.is_empty() || schema.len() > 32 {
            return Err("unsupported legacy provider node schema");
        }
        let mut columns = HashSet::with_capacity(schema.len());
        for column in schema {
            let name: String = column
                .try_get("name")
                .map_err(|_| "invalid legacy provider node schema")?;
            let hidden: i64 = column
                .try_get("hidden")
                .map_err(|_| "invalid legacy provider node schema")?;
            if hidden != 0 || name.is_empty() || name.len() > 128 {
                return Err("unsupported legacy provider node schema");
            }
            columns.insert(name);
        }
        for required in ["id", "type", "name", "prefix", "base_url"] {
            if !columns.contains(required) {
                return Err("legacy provider node schema is incomplete");
            }
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM provider_nodes")
            .fetch_one(&mut *snapshot)
            .await
            .map_err(|_| "cannot count legacy provider definitions")?;
        if !(0..=10_000).contains(&count) {
            return Err("too many legacy provider definitions");
        }
        let fields = [
            "api_type",
            "chat_path",
            "models_path",
            "custom_headers_json",
            "icon_url",
            "daily_quota_reset_timezone",
            "daily_quota_reset_hour",
            "tenant_id",
        ];
        let optional = fields
            .iter()
            .map(|name| format!("{} AS \"{name}\"", optional_column(&columns, name)))
            .collect::<Vec<_>>()
            .join(",");
        let statement = format!(
            "SELECT id,type,name,prefix,base_url,{optional} FROM provider_nodes ORDER BY id"
        );
        let rows = sqlx::query(&statement)
            .fetch_all(&mut *snapshot)
            .await
            .map_err(|_| "cannot read legacy provider definitions")?;
        let mut namespaces = HashSet::with_capacity(rows.len());
        let mut imported = 0_u64;
        for row in rows {
            let required = |name: &str| -> Result<String, &'static str> {
                row.try_get::<String, _>(name)
                    .map_err(|_| "invalid legacy provider definition")
            };
            let text = |name: &str| -> Result<Option<String>, &'static str> {
                row.try_get::<Option<String>, _>(name)
                    .map_err(|_| "invalid legacy provider definition")
            };
            let id = required("id")?;
            let node_type = required("type")?;
            let name = required("name")?;
            let prefix = required("prefix")?;
            let base_url = required("base_url")?;
            let api_type = text("api_type")?;
            let chat_path = text("chat_path")?.filter(|value| !value.is_empty());
            let models_path = text("models_path")?.filter(|value| !value.is_empty());
            let icon = text("icon_url")?.filter(|value| !value.trim().is_empty());
            let timezone = text("daily_quota_reset_timezone")?
                .filter(|value| !value.trim().is_empty());
            let reset_hour = row
                .try_get::<Option<i64>, _>("daily_quota_reset_hour")
                .map_err(|_| "invalid legacy provider definition")?;
            if icon.is_some() {
                return Err("legacy provider node icon requires migration");
            }
            if timezone.is_some() || reset_hour.is_some() {
                return Err("legacy provider node quota clock requires migration");
            }
            let tenant = text("tenant_id")?.unwrap_or_else(|| "red".to_owned());
            if !valid_id(&id) || !valid_id(&tenant) {
                return Err("invalid legacy provider node identifier");
            }
            if name.trim().is_empty()
                || name.encode_utf16().count() > 200
                || name.chars().any(char::is_control)
            {
                return Err("invalid legacy provider node name");
            }
            if !valid_prefix(&prefix) || reserved_prefix(&prefix)? {
                return Err("legacy provider node prefix is unavailable");
            }
            if base_url.len() > 2048 {
                return Err("legacy provider node base URL is too long");
            }
            let protocol = protocol(&node_type, api_type.as_deref(), &id)?;
            let path = chat_path
                .as_deref()
                .unwrap_or(crate::control_plane::provider_nodes::default_chat_path(protocol)?);
            let upstream_url = crate::control_plane::provider_nodes::endpoint(&base_url, path)?;
            let mut node = StoredProviderNode {
                id: id.clone(),
                tenant_id: tenant.clone(),
                name: name.trim().to_owned(),
                prefix: prefix.clone(),
                protocol: protocol.to_owned(),
                base_url: base_url.trim_end_matches('/').to_owned(),
                chat_path: path.to_owned(),
                upstream_url,
                models_path,
                revision: 1,
                header_config: None,
            };
            crate::control_plane::provider_nodes::models_path(&node)?;
            let headers = match text("custom_headers_json")? {
                None => BTreeMap::new(),
                Some(value) if matches!(value.trim(), "" | "null" | "{}") => BTreeMap::new(),
                Some(value) => serde_json::from_str::<BTreeMap<String, String>>(&value)
                    .map_err(|_| "invalid legacy provider node headers")?,
            };
            node.header_config = crate::control_plane::provider_headers::encrypt_definition_headers(
                &node,
                &headers,
                storage_key,
            )
            .await?;
            let tenant_exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM redrouter_control_tenants WHERE id=? AND enabled=1",
            )
            .bind(&tenant)
            .fetch_one(&mut *target)
            .await
            .map_err(|_| "destination tenant schema unavailable")?;
            if tenant_exists != 1 {
                return Err("legacy provider node tenant is unavailable");
            }
            let namespace = format!("{tenant}:{prefix}");
            if !namespaces.insert(namespace.clone()) {
                return Err("legacy provider node prefix is duplicated");
            }
            let document =
                serde_json::to_string(&node).map_err(|_| "invalid provider definition")?;
            let inserted = sqlx::query("INSERT INTO redrouter_control_provider_nodes (id,tenant_id,namespace,config_json,revision) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING")
                .bind(&id)
                .bind(&tenant)
                .bind(&namespace)
                .bind(document)
                .bind(node.revision)
                .execute(&mut *target)
                .await
                .map_err(|_| "cannot write provider definition")?;
            if inserted.rows_affected() != 1 {
                return Err("destination provider definition already exists");
            }
            imported = imported.checked_add(1).ok_or("provider definition count overflow")?;
        }
        Ok(ProviderNodeImport { imported })
    }
    .await;
    match result {
        Ok(report) => {
            snapshot
                .commit()
                .await
                .map_err(|_| "cannot finish legacy provider definition snapshot")?;
            target
                .commit()
                .await
                .map_err(|_| "cannot commit provider definition import")?;
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
