//! Strict offline import of legacy exact model aliases.
//!
//! Exact aliases for built-in and verified custom OpenAI-compatible chat
//! transports. Managed and wildcard aliases and unsupported protocols must be
//! migrated separately.
use crate::{
    control_plane::{model_aliases, provider_nodes},
    storage::{StoredModelAlias, StoredProviderNode},
};
use futures_util::TryStreamExt;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
};

#[derive(Debug, serde::Serialize)]
pub struct AliasImport {
    pub imported: u64,
    pub already_present: u64,
}

/// The legacy resolver accepts a string, a single-element string array, or
/// an object with provider/model fields. Reject extra information rather than
/// silently discarding it during cutover.
fn alias_destination(value: &serde_json::Value) -> Option<(&str, &str)> {
    let qualified = match value {
        serde_json::Value::String(value) => Some(value.as_str()),
        serde_json::Value::Array(values) if values.len() == 1 => values[0].as_str(),
        serde_json::Value::Object(object)
            if object.len() == 2
                && object.contains_key("provider")
                && object.contains_key("model") =>
        {
            return Some((
                object.get("provider")?.as_str()?,
                object.get("model")?.as_str()?,
            ));
        }
        _ => None,
    }?;
    qualified.split_once('/')
}

/// A legacy alias may address a custom node by its public prefix or node ID.
/// Require the original definition and its already imported equivalent to
/// agree before mapping the alias to the Rust provider namespace.
async fn compatible_node_provider(
    source: &mut SqliteConnection,
    destination: &mut SqliteConnection,
    name: &str,
) -> Result<Option<String>, &'static str> {
    let definition: Option<String> = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_nodes'",
    )
    .fetch_optional(&mut *source)
    .await
    .map_err(|_| "cannot inspect legacy provider definitions")?;
    let Some(definition) = definition else {
        return Ok(None);
    };
    if definition.to_ascii_uppercase().contains("VIRTUAL TABLE") {
        return Err("unsupported legacy provider node schema");
    }
    let mut columns = HashSet::new();
    for row in sqlx::query("PRAGMA table_xinfo('provider_nodes')")
        .fetch_all(&mut *source)
        .await
        .map_err(|_| "cannot inspect legacy provider definitions")?
    {
        let hidden: i64 = row
            .try_get("hidden")
            .map_err(|_| "invalid legacy provider node schema")?;
        if hidden != 0 {
            return Err("unsupported legacy provider node schema");
        }
        columns.insert(
            row.try_get::<String, _>("name")
                .map_err(|_| "invalid legacy provider node schema")?,
        );
    }
    if ["id", "prefix", "type", "base_url"]
        .iter()
        .any(|column| !columns.contains(*column))
    {
        return Err("legacy provider node schema incomplete");
    }
    let optional = |column: &'static str| -> &'static str {
        if columns.contains(column) {
            column
        } else {
            "NULL"
        }
    };
    let sql = format!("SELECT id,prefix,type,base_url,{} AS tenant_id,{} AS api_type,{} AS chat_path FROM provider_nodes WHERE id=? OR prefix=? LIMIT 2", optional("tenant_id"), optional("api_type"), optional("chat_path"));
    let rows = sqlx::query(&sql)
        .bind(name)
        .bind(name)
        .fetch_all(&mut *source)
        .await
        .map_err(|_| "cannot read legacy provider definition")?;
    if rows.len() > 1 {
        return Err("ambiguous legacy provider definition");
    }
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let id: String = row
        .try_get("id")
        .map_err(|_| "invalid legacy provider definition")?;
    let prefix: String = row
        .try_get("prefix")
        .map_err(|_| "invalid legacy provider definition")?;
    let kind: String = row
        .try_get("type")
        .map_err(|_| "invalid legacy provider definition")?;
    let base: String = row
        .try_get("base_url")
        .map_err(|_| "invalid legacy provider definition")?;
    let tenant: Option<String> = row
        .try_get("tenant_id")
        .map_err(|_| "invalid legacy provider definition")?;
    let api_type: Option<String> = row
        .try_get("api_type")
        .map_err(|_| "invalid legacy provider definition")?;
    let chat_path: Option<String> = row
        .try_get("chat_path")
        .map_err(|_| "invalid legacy provider definition")?;
    if tenant.as_deref().unwrap_or("red") != "red"
        || kind != "openai-compatible"
        || api_type
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("chat")
            != "chat"
    {
        return Err("legacy alias destination requires migration");
    }
    let chat_path = chat_path.as_deref().unwrap_or("/chat/completions");
    let upstream = provider_nodes::endpoint(&base, chat_path)?;
    let document: Option<String> = sqlx::query_scalar(
        "SELECT config_json FROM redrouter_control_provider_nodes WHERE id=? AND tenant_id='red'",
    )
    .bind(&id)
    .fetch_optional(&mut *destination)
    .await
    .map_err(|_| "destination provider definitions unavailable")?;
    let node: StoredProviderNode = serde_json::from_str(
        document
            .as_deref()
            .ok_or("import legacy provider definition before its aliases")?,
    )
    .map_err(|_| "invalid destination provider definition")?;
    if node.id != id
        || node.tenant_id != "red"
        || node.prefix != prefix
        || node.protocol != "openai"
        || node.base_url != base.trim_end_matches('/')
        || node.chat_path != chat_path
        || node.upstream_url != upstream
    {
        return Err("legacy provider definition does not match destination");
    }
    Ok(Some(prefix))
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
            let mut rows = sqlx::query("SELECT namespace,key,value FROM key_value WHERE namespace IN ('modelAliases','managedModelAliasNames','providerAliases') OR (namespace='settings' AND key IN ('modelAliases','wildcardAliases','stripModelPrefix')) ORDER BY namespace,key").fetch(&mut *snapshot);
            let mut row_count = 0_usize;
            let mut aliases = BTreeMap::new();
            let mut settings = None;
            let mut managed = HashSet::new();
            let mut bytes = 0_usize;
            while let Some(row) = rows.try_next().await.map_err(|_| "cannot read legacy aliases")? {
                row_count += 1;
                if row_count > 10004 { return Err("too many legacy aliases"); }
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
                    ("settings", "stripModelPrefix") => if value != serde_json::Value::Bool(false) && !value.is_null() { return Err("legacy prefix stripping requires migration"); },
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
                for (key,value) in settings {
                    if !value.is_string() { return Err("legacy alias destination requires migration"); }
                    aliases.insert(key.clone(), value.clone());
                }
            }
            if aliases.len() > 10_000 { return Err("too many legacy aliases"); }
            if !managed.is_empty() { return Err("managed aliases require migration"); }
            let tenant_exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_tenants WHERE id='red' AND enabled=1").fetch_one(&mut *target).await.map_err(|_| "destination tenant unavailable")?;
            if tenant_exists != 1 { return Err("destination tenant unavailable"); }
            if !aliases.is_empty() {
                let other_tenants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_tenants WHERE id <> 'red'").fetch_one(&mut *target).await.map_err(|_| "destination tenant unavailable")?;
                if other_tenants != 0 { return Err("legacy global aliases require tenant mapping"); }
            }
            let mut imported = 0;
            let mut already_present = 0;
            let mut custom_providers: HashMap<String, String> = HashMap::new();
            for (alias,value) in aliases {
                let (legacy_provider, model) = alias_destination(&value).ok_or("legacy alias destination requires migration")?;
                let provider = crate::model_permissions::legacy_provider_id(legacy_provider).unwrap_or(legacy_provider);
                let provider = if crate::product_provider::supports_model(provider, model) {
                    provider.to_owned()
                } else if let Some(provider) = custom_providers.get(legacy_provider) {
                    provider.clone()
                } else {
                    let provider = compatible_node_provider(&mut snapshot, &mut target, legacy_provider).await?
                        .ok_or("legacy alias destination requires migration")?;
                    custom_providers.insert(legacy_provider.to_owned(), provider.clone());
                    provider
                };
                let record = StoredModelAlias { id: model_aliases::record_id("red", &alias), tenant_id: "red".into(), provider, alias, model: model.into(), protocol: "openai".into(), enabled: true, revision: 1 };
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

#[cfg(test)]
mod tests {
    use super::alias_destination;

    #[test]
    fn structured_aliases_refuse_additional_data() {
        let single = serde_json::json!(["openrouter/vendor/model"]);
        assert_eq!(
            alias_destination(&single),
            Some(("openrouter", "vendor/model"))
        );
        let object = serde_json::json!({"provider":"openai","model":"gpt-4o"});
        assert_eq!(alias_destination(&object), Some(("openai", "gpt-4o")));
        assert!(alias_destination(&serde_json::json!(["openai/one", "openai/two"])).is_none());
        assert!(alias_destination(
            &serde_json::json!({"provider":"openai","model":"one","future":true})
        )
        .is_none());
        assert!(alias_destination(&serde_json::json!([])).is_none());
    }
}
