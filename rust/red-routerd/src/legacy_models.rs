//! Offline import of the subset of legacy custom models with native equivalents.
//! Any unsupported behavior rolls back the entire import.
use crate::{
    catalog::ModelMetadata,
    control_plane::provider_models,
    storage::{StoredProviderModel, StoredProviderNode},
};
use futures_util::TryStreamExt;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::Path,
};

#[derive(Debug, serde::Serialize)]
pub struct ModelImport {
    pub imported: u64,
    pub already_present: u64,
}

struct LegacyNode {
    tenant: String,
    prefix: String,
    node_type: String,
    api_type: Option<String>,
    base_url: String,
}

async fn resolve_provider(
    target: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    nodes: &HashMap<String, LegacyNode>,
    legacy_provider: &str,
) -> Result<(String, String), &'static str> {
    let (tenant, provider) = if let Some(source_node) = nodes.get(legacy_provider) {
        let document: Option<String> = sqlx::query_scalar(
            "SELECT config_json FROM redrouter_control_provider_nodes WHERE id=? AND tenant_id=?",
        )
        .bind(legacy_provider)
        .bind(&source_node.tenant)
        .fetch_optional(&mut **target)
        .await
        .map_err(|_| "destination provider definitions unavailable")?;
        let node: StoredProviderNode = serde_json::from_str(
            document
                .as_deref()
                .ok_or("import legacy provider definition before its models")?,
        )
        .map_err(|_| "invalid destination provider definition")?;
        if node.id != legacy_provider
            || node.tenant_id != source_node.tenant
            || node.prefix != source_node.prefix
            || node.base_url != source_node.base_url.trim_end_matches('/')
        {
            return Err("legacy provider definition does not match destination");
        }
        if source_node.node_type != "openai-compatible"
            || source_node
                .api_type
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("chat")
                != "chat"
            || node.protocol != "openai"
        {
            return Err("legacy model protocol requires migration");
        }
        (source_node.tenant.clone(), source_node.prefix.clone())
    } else {
        if legacy_provider.starts_with("openai-compatible-")
            || legacy_provider.starts_with("anthropic-compatible-")
            || legacy_provider.starts_with("claude-code-compatible-")
        {
            return Err("legacy provider definition unavailable");
        }
        let exists: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_provider_nodes WHERE id=?")
                .bind(legacy_provider)
                .fetch_one(&mut **target)
                .await
                .map_err(|_| "destination provider definitions unavailable")?;
        if exists != 0 {
            return Err("legacy provider definition unavailable");
        }
        (
            "red".to_owned(),
            crate::model_permissions::legacy_provider_id(legacy_provider)
                .unwrap_or(legacy_provider)
                .to_owned(),
        )
    };
    crate::control_plane::validate_provider(&provider)?;
    let exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM redrouter_control_tenants WHERE id=? AND enabled=1",
    )
    .bind(&tenant)
    .fetch_one(&mut **target)
    .await
    .map_err(|_| "destination tenant unavailable")?;
    if exists != 1 {
        return Err("destination tenant unavailable");
    }
    Ok((tenant, provider))
}

async fn preserve_activation_default(
    target: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    tenant: &str,
    provider: &str,
) -> Result<(), &'static str> {
    sqlx::query("INSERT INTO redrouter_control_model_activation_defaults (tenant_id,provider,revision) VALUES (?,?,1) ON CONFLICT(tenant_id,provider) DO NOTHING")
        .bind(tenant).bind(provider).execute(&mut **target).await.map_err(|_| "cannot preserve model activation defaults")?;
    Ok(())
}

fn owner_tenants(
    nodes: &HashMap<String, LegacyNode>,
    owners: &HashMap<String, BTreeSet<String>>,
    legacy_provider: &str,
    provider: &str,
    fallback: &str,
) -> Vec<String> {
    if nodes.contains_key(legacy_provider) {
        return vec![fallback.to_owned()];
    }
    let mut tenants = owners.get(provider).cloned().unwrap_or_default();
    if provider == "opencode" {
        for sibling in ["opencode-zen", "opencode-go"] {
            if let Some(owners) = owners.get(sibling) {
                tenants.extend(owners.iter().cloned());
            }
        }
    }
    if tenants.is_empty() {
        vec![fallback.to_owned()]
    } else {
        tenants.into_iter().collect()
    }
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
    let result = async {
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
        sqlx::query(crate::storage::CREATE_ACTIVATION_DEFAULTS).execute(&mut *target).await.map_err(|_| "cannot initialize model activation defaults")?;
        // Resolve legacy node IDs before streaming the model rows: IDs can be
        // longer than a provider prefix and cannot safely be guessed from it.
        let mut nodes = HashMap::new();
        let table: Option<String> = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_nodes'")
            .fetch_optional(&mut *snapshot).await.map_err(|_| "cannot inspect legacy provider definitions")?;
        if let Some(definition) = table {
            if definition.to_ascii_uppercase().contains("VIRTUAL TABLE") { return Err("unsupported legacy provider node schema"); }
            let columns = sqlx::query("PRAGMA table_xinfo('provider_nodes')").fetch_all(&mut *snapshot).await.map_err(|_| "cannot inspect legacy provider definitions")?;
            let mut names = HashSet::new();
            for column in columns {
                let hidden: i64 = column.try_get("hidden").map_err(|_| "invalid legacy provider definition schema")?;
                let name: String = column.try_get("name").map_err(|_| "invalid legacy provider definition schema")?;
                if hidden != 0 { return Err("unsupported legacy provider node schema"); }
                names.insert(name);
            }
            if ["id", "prefix", "type", "base_url"].iter().any(|name| !names.contains(*name)) { return Err("legacy provider node schema incomplete"); }
            let tenant_field = if names.contains("tenant_id") { "tenant_id" } else { "NULL AS tenant_id" };
            let api_field = if names.contains("api_type") { "api_type" } else { "NULL AS api_type" };
            let query = format!("SELECT id,prefix,type,base_url,{tenant_field},{api_field} FROM provider_nodes ORDER BY id");
            let mut source_nodes = sqlx::query(&query).fetch(&mut *snapshot);
            while let Some(row) = source_nodes.try_next().await.map_err(|_| "cannot read legacy provider definitions")? {
                if nodes.len() >= 10_000 { return Err("too many legacy provider definitions"); }
                let id: String = row.try_get("id").map_err(|_| "invalid legacy provider definition")?;
                let prefix: String = row.try_get("prefix").map_err(|_| "invalid legacy provider definition")?;
                let tenant: Option<String> = row.try_get("tenant_id").map_err(|_| "invalid legacy provider definition")?;
                let tenant = tenant.unwrap_or_else(|| "red".to_owned());
                let node_type: String = row.try_get("type").map_err(|_| "invalid legacy provider definition")?;
                let api_type: Option<String> = row.try_get("api_type").map_err(|_| "invalid legacy provider definition")?;
                let base_url: String = row.try_get("base_url").map_err(|_| "invalid legacy provider definition")?;
                if id.is_empty() || id.len() > 128 || tenant.is_empty() || tenant.len() > 128 || prefix.len() > 64 || node_type.len() > 128 || base_url.len() > 2048 || api_type.as_ref().is_some_and(|value| value.len() > 128) { return Err("invalid legacy provider definition"); }
                if nodes.insert(id, LegacyNode { tenant, prefix, node_type, api_type, base_url }).is_some() { return Err("duplicate legacy provider definition"); }
            }
        }
        // The old catalog's activation choices were provider-wide. Copy them
        // into each organization that actually owns an account, while a
        // reusable node remains scoped to its own organization.
        let mut connection_owners: HashMap<String, BTreeSet<String>> = HashMap::new();
        let connection_schema: Option<String> = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_connections'")
            .fetch_optional(&mut *snapshot).await.map_err(|_| "cannot inspect legacy provider connections")?;
        if let Some(schema) = connection_schema {
            if schema.to_ascii_uppercase().contains("VIRTUAL TABLE") { return Err("unsupported legacy provider connections"); }
            let columns = sqlx::query("PRAGMA table_xinfo('provider_connections')").fetch_all(&mut *snapshot).await.map_err(|_| "cannot inspect legacy provider connections")?;
            let mut names = HashSet::new();
            for column in columns {
                let hidden: i64 = column.try_get("hidden").map_err(|_| "invalid legacy provider connections")?;
                let name: String = column.try_get("name").map_err(|_| "invalid legacy provider connections")?;
                if hidden != 0 { return Err("unsupported legacy provider connections"); }
                names.insert(name);
            }
            if !names.contains("provider") {
                let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM provider_connections").fetch_one(&mut *snapshot).await.map_err(|_| "cannot inspect legacy provider connections")?;
                if count != 0 { return Err("legacy provider connection identity unavailable"); }
            } else {
                let tenant_column = if names.contains("tenant_id") { "tenant_id" } else { "NULL AS tenant_id" };
                let query = format!("SELECT DISTINCT provider,{tenant_column} FROM provider_connections ORDER BY provider,tenant_id");
                let mut connections = sqlx::query(&query).fetch(&mut *snapshot);
                let mut count = 0usize;
                while let Some(row) = connections.try_next().await.map_err(|_| "cannot read legacy provider connections")? {
                    count += 1;
                    if count > 10_000 { return Err("too many legacy provider connections"); }
                    let legacy_provider: String = row.try_get("provider").map_err(|_| "invalid legacy provider connection")?;
                    let tenant: Option<String> = row.try_get("tenant_id").map_err(|_| "invalid legacy provider connection tenant")?;
                    let tenant = tenant.unwrap_or_else(|| "red".to_owned());
                    let (resolved_tenant, provider) = resolve_provider(&mut target, &nodes, &legacy_provider).await?;
                    if nodes.contains_key(&legacy_provider) && tenant != resolved_tenant { return Err("legacy provider node tenant does not match its connection"); }
                    let tenant_exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_tenants WHERE id=? AND enabled=1")
                        .bind(&tenant).fetch_one(&mut *target).await.map_err(|_| "destination tenant unavailable")?;
                    if tenant_exists != 1 { return Err("destination tenant unavailable"); }
                    preserve_activation_default(&mut target, &tenant, &provider).await?;
                    if provider == "opencode" {
                        preserve_activation_default(&mut target, &tenant, "opencode-zen").await?;
                        preserve_activation_default(&mut target, &tenant, "opencode-go").await?;
                    }
                    connection_owners.entry(provider).or_default().insert(tenant);
                }
            }
        }
        // Model-specific transport, headers and visibility can also live in
        // a separate namespace. Do not import a model whose matching override
        // would otherwise be silently lost.
        let mut overrides: HashSet<(String, String)> = HashSet::new();
        let mut visibility: HashMap<(String, String), bool> = HashMap::new();
        let mut visibility_providers = HashSet::new();
        let mut compat = sqlx::query("SELECT key,value FROM key_value WHERE namespace='modelCompatOverrides' ORDER BY key").fetch(&mut *snapshot);
        let mut compat_bytes = 0_usize;
        let mut compat_rows = 0_usize;
        while let Some(row) = compat.try_next().await.map_err(|_| "legacy model compatibility unavailable")? {
            compat_rows += 1;
            if compat_rows > 10_000 { return Err("too many legacy model compatibility rows"); }
            let provider: String = row.try_get("key").map_err(|_| "invalid legacy model compatibility")?;
            let value: Option<String> = row.try_get("value").map_err(|_| "invalid legacy model compatibility")?;
            visibility_providers.insert(provider.clone());
            let Some(value) = value else { continue; };
            compat_bytes = compat_bytes.checked_add(value.len()).ok_or("legacy model compatibility too large")?;
            if provider.is_empty() || provider.len() > 128 || compat_bytes > 8 * 1024 * 1024 { return Err("invalid legacy model compatibility"); }
            let entries: Vec<serde_json::Value> = serde_json::from_str(&value).map_err(|_| "invalid legacy model compatibility")?;
            for entry in entries {
                if overrides.len().saturating_add(visibility.len()) >= 10_000 { return Err("too many legacy model compatibility entries"); }
                let object = entry.as_object().ok_or("invalid legacy model compatibility")?;
                let id = object.get("id").and_then(|value| value.as_str()).filter(|value| !value.is_empty() && value.len() <= 256).ok_or("invalid legacy model compatibility")?;
                // The legacy reader explicitly ignores retired isDeleted
                // tombstones; an ID-only entry has no runtime effect either.
                if object.keys().any(|key| !matches!(key.as_str(), "id" | "isDeleted" | "isHidden" | "hiddenModalities")) {
                    overrides.insert((provider.clone(), id.to_owned()));
                } else {
                    let scoped = match object.get("hiddenModalities") {
                        None | Some(serde_json::Value::Null) => None,
                        Some(value) => {
                            let Some(map) = value.as_object() else { return Err("invalid legacy model visibility"); };
                            if map.keys().any(|key| key != "chat") {
                                overrides.insert((provider.clone(), id.to_owned()));
                                continue;
                            }
                            match map.get("chat") {
                                None => None,
                                Some(value) => Some(value.as_bool().ok_or("invalid legacy model visibility")?),
                            }
                        }
                    };
                    let unscoped = match object.get("isHidden") {
                        None | Some(serde_json::Value::Null) => None,
                        Some(value) => Some(value.as_bool().ok_or("invalid legacy model visibility")?),
                    };
                    if let Some(hidden) = scoped.or(unscoped) {
                        visibility.insert((provider.clone(), id.to_owned()), hidden);
                    }
                }
            }
        }
        drop(compat);
        let mut rows = sqlx::query("SELECT key,value FROM key_value WHERE namespace='customModels' ORDER BY key").fetch(&mut *snapshot);
        let mut row_count = 0_u64;
        let mut seen = HashSet::new();
        let mut imported = 0_u64;
        let mut already_present = 0_u64;
        let mut bytes = 0_usize;
        while let Some(row) = rows.try_next().await.map_err(|_| "legacy model schema unavailable")? {
            row_count += 1;
            if row_count > 10_000 { return Err("too many legacy model rows"); }
            let legacy_provider: String = row.try_get("key").map_err(|_| "invalid legacy model provider")?;
            let (tenant, provider) = resolve_provider(&mut target, &nodes, &legacy_provider).await?;
            let tenants = owner_tenants(&nodes, &connection_owners, &legacy_provider, &provider, &tenant);
            for tenant in &tenants { preserve_activation_default(&mut target, tenant, &provider).await?; }
            let value: Option<String> = row.try_get("value").map_err(|_| "invalid legacy models")?;
            let Some(value) = value else { continue; };
            bytes = bytes.checked_add(value.len()).ok_or("legacy models too large")?;
            if bytes > 8 * 1024 * 1024 { return Err("legacy models too large"); }
            let models: Vec<serde_json::Value> = serde_json::from_str(&value).map_err(|_| "invalid legacy models")?;
            for tenant in tenants {
            for item in &models {
                if seen.len() >= 10_000 { return Err("too many legacy models"); }
                let object = item.as_object().ok_or("invalid legacy model")?;
                if object.keys().any(|key| !matches!(key.as_str(), "id" | "name" | "source" | "apiFormat" | "supportedEndpoints" | "inputTokenLimit" | "outputTokenLimit" | "supportsThinking" | "isHidden")) {
                    return Err("legacy model settings require migration");
                }
                if object.get("source").is_some_and(|v| v.as_str() != Some("manual"))
                    || object.get("apiFormat").is_some_and(|v| v.as_str() != Some("chat-completions"))
                    || object.get("supportedEndpoints").is_some_and(|v| v != &serde_json::json!(["chat"])) {
                    return Err("legacy model routing or provenance requires migration");
                }
                let id = object.get("id").and_then(|v| v.as_str()).ok_or("invalid legacy model")?;
                let mut keys = vec![legacy_provider.as_str(), provider.as_str()];
                if let Some(aliases) = crate::model_permissions::legacy_provider_spellings(&legacy_provider) {
                    keys.extend(aliases.iter().map(String::as_str));
                }
                if matches!(legacy_provider.as_str(), "opencode-zen" | "opencode-go") { keys.push("opencode"); }
                keys.sort_unstable();
                keys.dedup();
                if keys.iter().any(|key| overrides.contains(&((*key).to_owned(), id.to_owned()))) {
                    return Err("legacy model compatibility settings require migration");
                }
                let name = match object.get("name") { None | Some(serde_json::Value::Null) => id, Some(value) => value.as_str().ok_or("invalid legacy model name")? };
                let name = if name.is_empty() { id } else { name };
                let number = |field: &str| -> Result<Option<u64>, &'static str> {
                    match object.get(field) { None | Some(serde_json::Value::Null) => Ok(None), Some(value) => value.as_u64().map(Some).ok_or("invalid legacy model token limit") }
                };
                let input = number("inputTokenLimit")?;
                let output = number("outputTokenLimit")?;
                let reasoning = match object.get("supportsThinking") { None | Some(serde_json::Value::Null) => None, Some(value) => Some(value.as_bool().ok_or("invalid legacy model capability")?) };
                // Legacy catalog activation is opt-in. A custom decision wins
                // over compat for the same key; hidden wins across sibling keys.
                let explicit = match object.get("isHidden") { None | Some(serde_json::Value::Null) => None, Some(value) => Some(value.as_bool().ok_or("invalid legacy model visibility")?) };
                let own = explicit.or_else(|| visibility.get(&(legacy_provider.clone(), id.to_owned())).copied());
                let related = keys.into_iter().filter(|key| *key != legacy_provider.as_str())
                    .filter_map(|key| visibility.get(&(key.to_owned(), id.to_owned())).copied()).collect::<Vec<_>>();
                let hidden = own == Some(true) || related.contains(&true)
                    || (own.is_none() && !related.contains(&false));
                let mut metadata: ModelMetadata = serde_json::from_value(serde_json::json!({"id":id,"name":name,"reasoning":reasoning})).map_err(|_| "invalid legacy model")?;
                if input.is_some() || output.is_some() { metadata.limit = Some(crate::catalog::CatalogLimit { context: None, input, output }); }
                provider_models::validate_metadata(&metadata)?;
                let identity = provider_models::record_id(&tenant, &provider, id);
                if legacy_provider != provider && !nodes.contains_key(&legacy_provider) {
                    let old_id = provider_models::record_id(&tenant, &legacy_provider, id);
                    let old: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_provider_models WHERE id=?").bind(old_id).fetch_one(&mut *target).await.map_err(|_| "cannot inspect prior model import")?;
                    if old != 0 { return Err("prior provider-alias model import requires reconciliation"); }
                }
                if !seen.insert(identity.clone()) { return Err("duplicate legacy model"); }
                let record = StoredProviderModel { id: identity.clone(), tenant_id: tenant.clone(), provider: provider.clone(), metadata, hidden, visibility_only: false, revision: 1 };
                let namespace = serde_json::to_string(&(&record.tenant_id, &record.provider, &record.metadata.id)).map_err(|_| "invalid model identity")?;
                let document = serde_json::to_string(&record).map_err(|_| "invalid legacy model")?;
                let inserted = sqlx::query("INSERT INTO redrouter_control_provider_models (id,tenant_id,namespace,config_json,revision) VALUES (?,?,?,?,1) ON CONFLICT DO NOTHING").bind(&identity).bind(&tenant).bind(&namespace).bind(&document).execute(&mut *target).await.map_err(|_| "cannot import model")?.rows_affected();
                if inserted == 1 { imported += 1; } else {
                    let existing: Option<String> = sqlx::query_scalar("SELECT config_json FROM redrouter_control_provider_models WHERE id=? AND tenant_id=? AND namespace=?").bind(&identity).bind(&tenant).bind(&namespace).fetch_optional(&mut *target).await.map_err(|_| "cannot verify model")?;
                    if existing.as_deref() != Some(&document) { return Err("destination contains conflicting model"); }
                    already_present += 1;
                }
            }
            }
        }
        drop(rows);
        for legacy_provider in visibility_providers {
            let (tenant, provider) = resolve_provider(&mut target, &nodes, &legacy_provider).await?;
            let tenants = owner_tenants(&nodes, &connection_owners, &legacy_provider, &provider, &tenant);
            for tenant in tenants {
            preserve_activation_default(&mut target, &tenant, &provider).await?;
            if provider == "opencode" {
                preserve_activation_default(&mut target, &tenant, "opencode-zen").await?;
                preserve_activation_default(&mut target, &tenant, "opencode-go").await?;
            }
            }
        }
        // Visibility-only records affect existing catalog/inventory entries
        // without inventing a new routable model. Hidden wins across aliases.
        let mut visibility_records = std::collections::BTreeMap::new();
        for ((legacy_provider, id), hidden) in visibility {
            let (tenant, provider) = resolve_provider(&mut target, &nodes, &legacy_provider).await?;
            let tenants = owner_tenants(&nodes, &connection_owners, &legacy_provider, &provider, &tenant);
            let providers = if provider == "opencode" {
                vec![provider.as_str(), "opencode-zen", "opencode-go"]
            } else { vec![provider.as_str()] };
            for tenant in tenants {
            for provider in &providers {
            let identity = provider_models::record_id(&tenant, provider, &id);
            if seen.contains(&identity) { continue; }
            if let Some(existing) = visibility_records.get_mut(&identity) {
                let existing: &mut StoredProviderModel = existing;
                existing.hidden |= hidden;
                continue;
            }
            if seen.len().saturating_add(visibility_records.len()) >= 10_000 { return Err("too many legacy models"); }
            let metadata: ModelMetadata = serde_json::from_value(serde_json::json!({"id":&id}))
                .map_err(|_| "invalid legacy model")?;
            provider_models::validate_metadata(&metadata)?;
            let record = StoredProviderModel { id: identity.clone(), tenant_id: tenant.clone(), provider: (*provider).to_owned(), metadata, hidden, visibility_only: true, revision: 1 };
            visibility_records.insert(identity, record);
            }
            }
        }
        for (identity, record) in visibility_records {
            let tenant = &record.tenant_id;
            let namespace = serde_json::to_string(&(&record.tenant_id, &record.provider, &record.metadata.id)).map_err(|_| "invalid model identity")?;
            let document = serde_json::to_string(&record).map_err(|_| "invalid legacy model")?;
            let inserted = sqlx::query("INSERT INTO redrouter_control_provider_models (id,tenant_id,namespace,config_json,revision) VALUES (?,?,?,?,1) ON CONFLICT DO NOTHING")
                .bind(&identity).bind(tenant).bind(&namespace).bind(&document).execute(&mut *target).await.map_err(|_| "cannot import model visibility")?.rows_affected();
            if inserted == 1 { imported += 1; } else {
                let existing: Option<String> = sqlx::query_scalar("SELECT config_json FROM redrouter_control_provider_models WHERE id=? AND tenant_id=? AND namespace=?")
                    .bind(&identity).bind(tenant).bind(&namespace).fetch_optional(&mut *target).await.map_err(|_| "cannot verify model visibility")?;
                if existing.as_deref() != Some(&document) { return Err("destination contains conflicting model visibility"); }
                already_present += 1;
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
    }.await;
    let output_close = output.close().await;
    let input_close = input.close().await;
    if output_close.is_err() || input_close.is_err() {
        return Err("cannot close migration database");
    }
    result
}
