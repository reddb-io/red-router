//! Public model names resolved inside an organization before dispatch.
use super::*;
use crate::storage::{Database, StoredModelAlias};

const MAX_ALIASES: usize = 10_000;
const MAX_MODELS: usize = MAX_ALIASES;
#[derive(Default)]
pub(crate) struct AliasSnapshot {
    pub(crate) records: Vec<StoredModelAlias>,
    pub(crate) configured: bool,
    names: HashMap<String, HashMap<String, String>>,
    public_names: HashMap<String, String>,
}
pub(crate) fn record_id(tenant: &str, alias: &str) -> String {
    let mut digest = Sha256::new();
    signature_text(&mut digest, tenant);
    signature_text(&mut digest, alias);
    format!("model-alias-{}", hex::encode(digest.finalize()))
}
fn valid_model_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}
pub(crate) fn validate(record: &StoredModelAlias) -> Result<(), &'static str> {
    validate_id(&record.tenant_id)?;
    validate_provider(&record.provider)?;
    if !valid_model_name(&record.alias)
        || record.alias.starts_with("combo/")
        || record.alias.starts_with("model-alias-")
        || !valid_model_name(&record.model)
    {
        return Err("Invalid model alias or upstream model ID");
    }
    ProviderProtocol::parse(&record.protocol)?;
    if record.id != record_id(&record.tenant_id, &record.alias) {
        return Err("Invalid model alias identity");
    }
    Ok(())
}
impl AliasSnapshot {
    pub(crate) async fn load(db: &Database) -> Result<Self, &'static str> {
        let records = db.model_aliases().await?;
        if records.len() > MAX_ALIASES {
            return Err("Model alias snapshot exceeds its limit");
        }
        let mut names: HashMap<String, HashMap<String, String>> = HashMap::new();
        let mut public_names = HashMap::new();
        for record in &records {
            validate(record)?;
            public_names.insert(record.id.clone(), record.alias.clone());
            if names
                .entry(record.tenant_id.clone())
                .or_default()
                .insert(record.alias.clone(), record.id.clone())
                .is_some()
            {
                return Err("Duplicate model alias in organization");
            }
        }
        let configured = !records.is_empty() || db.alias_routing_configured().await?;
        Ok(Self {
            records,
            names,
            configured,
            public_names,
        })
    }
    pub(crate) fn resolve(&self, tenant: &str, name: &str) -> Option<&str> {
        self.names.get(tenant)?.get(name).map(String::as_str)
    }
    pub(crate) fn public_name(&self, id: &str) -> Option<&str> {
        self.public_names.get(id).map(String::as_str)
    }
    pub(crate) fn virtual_combos(
        &self,
        providers: &[StoredProvider],
    ) -> Result<Vec<StoredCombo>, &'static str> {
        let mut accounts: HashMap<(&str, &str), Vec<&StoredProvider>> = HashMap::new();
        for provider in providers.iter().filter(|provider| provider.enabled) {
            accounts
                .entry((&provider.tenant_id, &provider.provider))
                .or_default()
                .push(provider);
        }
        for pool in accounts.values_mut() {
            // The legacy fill-first selector treats zero as unspecified, then
            // prefers the most recently updated connection on equal priority.
            let rank = |priority| if priority == 0 { 999 } else { priority };
            pool.sort_by(|a, b| {
                rank(a.priority)
                    .cmp(&rank(b.priority))
                    .then_with(|| b.updated_at.cmp(&a.updated_at))
                    .then_with(|| a.id.cmp(&b.id))
            });
        }
        let mut total_targets = 0usize;
        self.records.iter().map(|alias| {
            let targets: Vec<_> = accounts.get(&(alias.tenant_id.as_str(), alias.provider.as_str())).into_iter().flatten()
                .map(|provider|serde_json::json!({"provider_id":provider.id,"model":alias.model})).collect();
            total_targets = total_targets.checked_add(targets.len()).ok_or("Model alias snapshot exceeds its limit")?;
            if total_targets > 100_000 { return Err("Model alias snapshot exceeds its limit"); }
            Ok(StoredCombo {
                id: alias.id.clone(), tenant_id:alias.tenant_id.clone(), protocol:alias.protocol.clone(),
                strategy:"priority".to_owned(), fallback:true, enabled:alias.enabled,
                targets_json:serde_json::to_string(&targets).map_err(|_|"Invalid alias targets")?, revision:alias.revision,
            })
        }).collect()
    }
}
/// Alias targets are compiled from validated provider records, not operator combo
/// payloads. Empty pools and more than eight accounts have their own dispatch path.
pub(super) fn route_view(record: &StoredCombo) -> Result<ComboView, &'static str> {
    Ok(ComboView {
        id: record.id.clone(),
        tenant_id: record.tenant_id.clone(),
        protocol: record.protocol.clone(),
        strategy: record.strategy.clone(),
        fallback: record.fallback,
        targets: serde_json::from_str(&record.targets_json)
            .map_err(|_| "Invalid compiled model alias targets")?,
        auto: None,
        context_relay: None,
        fusion: None,
        pipeline: None,
        enabled: record.enabled,
        revision: record.revision.to_string(),
        last_known_good: None,
    })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AliasInput {
    tenant_id: Option<String>,
    alias: String,
    provider: String,
    model: String,
    #[serde(default = "openai_protocol")]
    protocol: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
    revision: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AliasQuery {
    tenant_id: Option<String>,
    provider: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
    revision: Option<String>,
}
fn view(row: &StoredModelAlias) -> Result<serde_json::Value, &'static str> {
    Ok(
        serde_json::json!({"id":row.id,"tenant_id":row.tenant_id,"alias":row.alias,
        "provider":row.provider,"model":row.model,"protocol":row.protocol,"enabled":row.enabled,"revision":row.revision.to_string()}),
    )
}
fn failure(message: &'static str) -> Response {
    let status = if message.contains("changed; reload") || message.contains("already exists") {
        StatusCode::CONFLICT
    } else if message == "Model alias unavailable" {
        StatusCode::NOT_FOUND
    } else if message.starts_with("cannot ")
        || message.contains("storage")
        || message.contains("snapshot")
    {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::BAD_REQUEST
    };
    api_error(status, message)
}
impl ControlPlane {
    pub(super) async fn refresh_model_aliases(&self) -> Result<(), &'static str> {
        match AliasSnapshot::load(&self.0.database).await {
            Ok(aliases) => {
                *self.0.model_aliases.write().await = Some(Arc::new(aliases));
                Ok(())
            }
            Err(error) => {
                *self.0.model_aliases.write().await = None;
                Err(error)
            }
        }
    }
    pub(crate) async fn model_aliases_snapshot(&self) -> Result<Arc<AliasSnapshot>, &'static str> {
        self.0
            .model_aliases
            .read()
            .await
            .clone()
            .ok_or("Model alias snapshot unavailable")
    }
    async fn save_model_alias(
        &self,
        requested_id: Option<&str>,
        input: AliasInput,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<StoredModelAlias, &'static str> {
        let _mutation = self.0.mutation.lock().await;
        validate_actor(actor)?;
        let tenant = input
            .tenant_id
            .as_deref()
            .or(enforced_tenant)
            .unwrap_or("red");
        if enforced_tenant.is_some_and(|allowed| allowed != tenant) {
            return Err("Model alias unavailable");
        }
        let rows = self.0.database.model_aliases().await?;
        let id = record_id(tenant, &input.alias);
        if requested_id.is_some_and(|requested| requested != id) {
            return Err("Organization and alias cannot change; create another alias");
        }
        let existing = rows.iter().find(|row| row.id == id);
        if requested_id.is_none() && existing.is_some() {
            return Err("Model alias already exists; reload before editing");
        }
        if requested_id.is_some() && existing.is_none() {
            return Err("Model alias unavailable");
        }
        let expected = input
            .revision
            .as_deref()
            .map(|value| value.parse::<i64>().map_err(|_| "Invalid alias revision"))
            .transpose()?;
        if existing.map(|row| row.revision) != expected {
            return Err("Model alias changed; reload and retry");
        }
        if existing.is_none() && rows.len() >= MAX_ALIASES {
            return Err("Model alias snapshot exceeds its limit");
        }
        let row = StoredModelAlias {
            id,
            tenant_id: tenant.to_owned(),
            alias: input.alias,
            provider: input.provider,
            model: input.model,
            protocol: input.protocol,
            enabled: input.enabled,
            revision: revision()?.max(
                expected
                    .unwrap_or(0)
                    .checked_add(1)
                    .ok_or("Invalid alias revision")?,
            ),
        };
        validate(&row)?;
        if !self
            .0
            .database
            .tenants()
            .await?
            .iter()
            .any(|org| org.id == tenant && org.enabled)
        {
            return Err("Model alias organization is unavailable");
        }
        if self
            .0
            .database
            .combos()
            .await?
            .iter()
            .any(|combo| combo.id == row.id || (combo.tenant_id == tenant && combo.id == row.alias))
        {
            return Err("A combo already exists with this name");
        }
        self.0.database.upsert_model_alias(&row, expected).await?;
        self.refresh_model_aliases().await?;
        if let Err(error) = self.refresh_routes().await {
            *self.0.current.write().await = None;
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        self.record_audit_event(
            AuditContext {
                action: "model.alias.upsert",
                actor,
                tenant_id: tenant,
                target: &row.id,
                resource_type: "model_alias",
            },
            existing,
            Some(&row),
        )
        .await;
        Ok(row)
    }
}

pub async fn list(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Query(query): Query<AliasQuery>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    if scope
        .tenant_id
        .as_ref()
        .zip(query.tenant_id.as_ref())
        .is_some_and(|(a, b)| a != b)
    {
        return api_error(StatusCode::NOT_FOUND, "Model alias unavailable");
    }
    let tenant = scope.tenant_id.as_deref().or(query.tenant_id.as_deref());
    let result: Result<_, &'static str> = async {
        let mut rows: Vec<_> = control
            .0
            .database
            .model_aliases()
            .await?
            .into_iter()
            .filter(|row| {
                tenant.is_none_or(|tenant| row.tenant_id == tenant)
                    && query
                        .provider
                        .as_ref()
                        .is_none_or(|provider| *provider == row.provider)
            })
            .collect();
        rows.sort_by(|a, b| {
            (&a.tenant_id, &a.provider, &a.alias).cmp(&(&b.tenant_id, &b.provider, &b.alias))
        });
        let total = rows.len();
        let offset = query.offset.unwrap_or(0).min(MAX_MODELS);
        let limit = query.limit.unwrap_or(50).clamp(1, 100);
        let models: Vec<_> = rows
            .iter()
            .skip(offset)
            .take(limit)
            .map(|row| view(row))
            .collect::<Result<_, _>>()?;
        Ok(serde_json::json!({"aliases":models,"total":total,"offset":offset,"limit":limit}))
    }
    .await;
    match result {
        Ok(result) => ([(header::CACHE_CONTROL, "no-store")], Json(result)).into_response(),
        Err(error) => failure(error),
    }
}

pub async fn get_one(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let result: Result<_, &'static str> = async {
        let record = control
            .0
            .database
            .model_aliases()
            .await?
            .into_iter()
            .find(|row| {
                row.id == id
                    && scope
                        .tenant_id
                        .as_ref()
                        .is_none_or(|tenant| *tenant == row.tenant_id)
            })
            .ok_or("Model alias unavailable")?;
        view(&record)
    }
    .await;
    match result {
        Ok(model) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({"alias":model})),
        )
            .into_response(),
        Err(error) => failure(error),
    }
}

pub async fn create(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<AliasInput>,
) -> Response {
    save(state, headers, None, input).await
}
pub async fn put(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<AliasInput>,
) -> Response {
    save(state, headers, Some(id), input).await
}
async fn save(
    state: ProxyState,
    headers: HeaderMap,
    id: Option<String>,
    input: AliasInput,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .save_model_alias(
            id.as_deref(),
            input,
            &scope.actor,
            scope.tenant_id.as_deref(),
        )
        .await
    {
        Ok(model) => match view(&model) {
            Ok(view) => (
                [(header::CACHE_CONTROL, "no-store")],
                Json(serde_json::json!({"alias":view})),
            )
                .into_response(),
            Err(error) => failure(error),
        },
        Err(error) => failure(error),
    }
}

pub async fn remove(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AliasQuery>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let _mutation = control.0.mutation.lock().await;
    let result: Result<(), &'static str> = async {
        let revision = query
            .revision
            .as_deref()
            .ok_or("Model revision is required")?
            .parse::<i64>()
            .map_err(|_| "Invalid model revision")?;
        let existing = control
            .0
            .database
            .model_aliases()
            .await?
            .into_iter()
            .find(|row| {
                row.id == id
                    && scope
                        .tenant_id
                        .as_ref()
                        .is_none_or(|tenant| *tenant == row.tenant_id)
            })
            .ok_or("Model alias unavailable")?;
        control
            .0
            .database
            .delete_model_alias(&id, &existing.tenant_id, revision)
            .await?;
        control.refresh_model_aliases().await?;
        if let Err(error) = control.refresh_routes().await {
            *control.0.current.write().await = None;
            *control.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        control
            .record_audit_event(
                AuditContext {
                    action: "model.alias.delete",
                    actor: &scope.actor,
                    tenant_id: &existing.tenant_id,
                    target: &id,
                    resource_type: "model_alias",
                },
                Some(&existing),
                Option::<&StoredModelAlias>::None,
            )
            .await;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => Json(serde_json::json!({"deleted":true})).into_response(),
        Err(error) => failure(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn alias_writes_are_scoped_and_deleted_routes_stay_explicit() {
        let db = Arc::new(
            Database::connect(crate::storage::Backend::Sqlite, "sqlite::memory:")
                .await
                .unwrap(),
        );
        let control = ControlPlane::new(
            db.clone(),
            "alias-test-admin-key-12345678901234567890",
            "alias-test-storage-key-12345678901234567890",
            true,
        )
        .await
        .unwrap();
        let input = || {
            serde_json::from_value(serde_json::json!({"tenant_id":"red","alias":"friendly","provider":"private-api","model":"upstream"})).unwrap()
        };
        assert_eq!(
            control
                .save_model_alias(None, input(), "manager:other", Some("other"))
                .await
                .err(),
            Some("Model alias unavailable")
        );
        let row = control
            .save_model_alias(None, input(), "manager:red", Some("red"))
            .await
            .unwrap();
        let snapshot = control.model_aliases_snapshot().await.unwrap();
        assert_eq!(snapshot.resolve("red", "friendly"), Some(row.id.as_str()));
        assert_eq!(snapshot.resolve("other", "friendly"), None);
        assert!(control
            .save_model_alias(None, input(), "manager:red", Some("red"))
            .await
            .is_err());
        let mut changed = row.clone();
        changed.revision += 1;
        changed.model = "new-target".into();
        assert!(db
            .upsert_model_alias(&changed, Some(row.revision - 1))
            .await
            .is_err());
        db.upsert_model_alias(&changed, Some(row.revision))
            .await
            .unwrap();
        assert!(db
            .delete_model_alias(&row.id, "other", changed.revision)
            .await
            .is_err());
        assert!(db
            .delete_model_alias(&row.id, "red", row.revision)
            .await
            .is_err());
        db.delete_model_alias(&row.id, "red", changed.revision)
            .await
            .unwrap();
        assert!(db.model_aliases().await.unwrap().is_empty());
        assert!(db.alias_routing_configured().await.unwrap());
        assert!(AliasSnapshot::load(&db).await.unwrap().configured);
        assert!(db
            .upsert_model_alias(&changed, Some(changed.revision))
            .await
            .is_err());
    }
}
