//! Tenant-owned custom model metadata. Catalog data never grants inference access.
use super::*;
use crate::{
    catalog::ModelMetadata,
    storage::{Database, StoredProviderModel},
};

type ProviderModels = HashMap<String, HashMap<String, ModelMetadata>>;
#[derive(Default)]
pub(crate) struct ModelOverrides {
    tenants: HashMap<String, ProviderModels>,
    hidden: HashMap<String, HashMap<String, HashSet<String>>>,
}
const MAX_MODELS: usize = 10_000;
const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;

pub(crate) fn record_id(tenant: &str, provider: &str, model: &str) -> String {
    let mut digest = Sha256::new();
    for value in [tenant, provider, model] {
        signature_text(&mut digest, value);
    }
    hex::encode(digest.finalize())
}

fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

pub(crate) fn validate_metadata(model: &ModelMetadata) -> Result<(), &'static str> {
    if !text(&model.id, 256) || model.id.trim() != model.id {
        return Err(
            "Model ID must contain 1-256 bytes without control characters or surrounding spaces",
        );
    }
    for value in [
        &model.name,
        &model.r#type,
        &model.canonical_model_id,
        &model.family,
        &model.knowledge,
        &model.release_date,
        &model.last_updated,
        &model.status,
    ]
    .into_iter()
    .flatten()
    {
        if !text(value, 256) {
            return Err("Invalid model metadata text");
        }
    }
    if let Some(limit) = &model.limit {
        for value in [limit.context, limit.input, limit.output]
            .into_iter()
            .flatten()
        {
            if value == 0 || value > 1_000_000_000 {
                return Err("Token limits must be between 1 and 1000000000");
            }
        }
        if limit
            .context
            .zip(limit.input)
            .is_some_and(|(context, input)| input > context)
        {
            return Err("Input token limit exceeds the context window");
        }
    }
    if let Some(cost) = &model.cost {
        for value in [
            cost.input,
            cost.output,
            cost.reasoning,
            cost.cache_read,
            cost.cache_write,
            cost.input_audio,
            cost.output_audio,
        ]
        .into_iter()
        .flatten()
        {
            if !value.is_finite() || !(0.0..=1_000_000_000.0).contains(&value) {
                return Err("Invalid model price per million tokens");
            }
        }
    }
    if let Some(modalities) = &model.modalities {
        for values in [&modalities.input, &modalities.output] {
            if values.len() > 16 || values.iter().any(|value| !text(value, 32)) {
                return Err("Invalid model modalities");
            }
        }
    }
    if let Some(crate::catalog::CatalogInterleaved::Field { field }) = &model.interleaved {
        if !text(field, 128) {
            return Err("Invalid interleaved model field");
        }
    }
    if let Some(options) = &model.reasoning_options {
        if options.len() > 8 {
            return Err("Too many model reasoning options");
        }
        for option in options {
            match option {
                crate::catalog::CatalogReasoningOption::Toggle => {}
                crate::catalog::CatalogReasoningOption::Effort { values } => {
                    if values.len() > 16 || values.iter().flatten().any(|value| !text(value, 64)) {
                        return Err("Invalid model reasoning efforts");
                    }
                }
                crate::catalog::CatalogReasoningOption::BudgetTokens { min, max } => {
                    if min.is_some_and(|value| !(-1..=1_000_000_000).contains(&value))
                        || max.is_some_and(|value| value > 1_000_000_000)
                        || min
                            .zip(*max)
                            .is_some_and(|(min, max)| min > 0 && min as u64 > max)
                    {
                        return Err("Invalid model reasoning budget");
                    }
                }
            }
        }
    }
    if serde_json::to_vec(model)
        .map_err(|_| "Invalid model metadata")?
        .len()
        > 8_192
    {
        return Err("Model metadata exceeds 8192 bytes");
    }
    Ok(())
}

/// Null fields inherit catalog values. Explicit false and zero prices override them.
pub(crate) fn overlay(base: Option<ModelMetadata>, patch: &ModelMetadata) -> ModelMetadata {
    let Some(mut model) = base else {
        return patch.clone();
    };
    macro_rules! replace { ($($field:ident),+ $(,)?) => { $(if patch.$field.is_some() {model.$field = patch.$field.clone();})+ }; }
    replace!(
        name,
        r#type,
        canonical_model_id,
        family,
        knowledge,
        release_date,
        last_updated,
        status,
        modalities,
        interleaved,
        reasoning_options
    );
    macro_rules! copy { ($($field:ident),+ $(,)?) => { $(if patch.$field.is_some() {model.$field = patch.$field;})+ }; }
    copy!(
        attachment,
        reasoning,
        tool_call,
        structured_output,
        temperature,
        open_weights
    );
    model.id = patch.id.clone();
    macro_rules! nested { ($field:ident: $($member:ident),+) => {
        if let Some(patch) = &patch.$field {
            if let Some(base) = &mut model.$field { $(if patch.$member.is_some() {base.$member = patch.$member;})+ }
            else { model.$field = Some(patch.clone()); }
        }
    }; }
    nested!(limit: context, input, output);
    nested!(cost: input, output, reasoning, cache_read, cache_write, input_audio, output_audio);
    model
}

impl ModelOverrides {
    pub(crate) fn configured_models<'a>(
        &'a self,
        tenant: &str,
        provider: &str,
    ) -> impl Iterator<Item = &'a ModelMetadata> {
        self.tenants
            .get(tenant)
            .and_then(|providers| providers.get(provider))
            .into_iter()
            .flat_map(|models| models.values())
    }

    pub(crate) async fn load(database: &Database) -> Result<Self, &'static str> {
        let records = database.provider_models().await?;
        if records.len() > MAX_MODELS {
            return Err("Provider model snapshot exceeds its limit");
        }
        let mut bytes = 0usize;
        let mut snapshot = Self::default();
        for record in records {
            validate_id(&record.tenant_id)?;
            validate_provider(&record.provider)?;
            validate_metadata(&record.metadata)?;
            if record.id != record_id(&record.tenant_id, &record.provider, &record.metadata.id) {
                return Err("Invalid provider model identity");
            }
            bytes += serde_json::to_vec(&record)
                .map_err(|_| "Invalid provider model storage")?
                .len();
            if bytes > MAX_SNAPSHOT_BYTES {
                return Err("Provider model snapshot exceeds its limit");
            }
            if record.hidden {
                snapshot
                    .hidden
                    .entry(record.tenant_id.clone())
                    .or_default()
                    .entry(record.provider.clone())
                    .or_default()
                    .insert(record.metadata.id.clone());
            }
            snapshot
                .tenants
                .entry(record.tenant_id)
                .or_default()
                .entry(record.provider)
                .or_default()
                .insert(record.metadata.id.clone(), record.metadata);
        }
        Ok(snapshot)
    }

    pub(crate) fn is_hidden(&self, tenant: &str, provider: &str, model: &str) -> bool {
        self.hidden
            .get(tenant)
            .and_then(|providers| providers.get(provider))
            .is_some_and(|models| models.contains(model))
    }

    pub(crate) fn model(
        &self,
        catalog: &crate::catalog::ModelCatalog,
        tenant: &str,
        provider: &str,
        id: &str,
    ) -> Result<Option<ModelMetadata>, &'static str> {
        let base = catalog.model(provider, id)?;
        Ok(
            match self
                .tenants
                .get(tenant)
                .and_then(|providers| providers.get(provider))
                .and_then(|models| models.get(id))
            {
                Some(patch) => {
                    let merged = overlay(base, patch);
                    validate_metadata(&merged)?;
                    Some(merged)
                }
                None => base,
            },
        )
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelInput {
    tenant_id: Option<String>,
    provider: String,
    metadata: ModelMetadata,
    hidden: Option<bool>,
    revision: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelQuery {
    tenant_id: Option<String>,
    provider: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
    revision: Option<String>,
}

fn view(
    model: &StoredProviderModel,
    catalog: &crate::catalog::ModelCatalog,
) -> Result<serde_json::Value, &'static str> {
    let effective = overlay(
        catalog.model(&model.provider, &model.metadata.id)?,
        &model.metadata,
    );
    Ok(
        serde_json::json!({"id":model.id,"tenant_id":model.tenant_id,"provider":model.provider,
        "metadata":model.metadata,"effective":effective,"hidden":model.hidden,"revision":model.revision.to_string()}),
    )
}

fn failure(message: &'static str) -> Response {
    let status = if message.contains("changed; reload")
        || message == "Model already exists; reload before editing"
    {
        StatusCode::CONFLICT
    } else if message == "Provider model unavailable" {
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
    pub(super) async fn refresh_provider_models(&self) -> Result<(), &'static str> {
        match ModelOverrides::load(&self.0.database).await {
            Ok(models) => {
                *self.0.provider_models.write().await = Some(Arc::new(models));
                Ok(())
            }
            Err(error) => {
                *self.0.provider_models.write().await = None;
                Err(error)
            }
        }
    }
    pub(crate) async fn provider_model_overrides(
        &self,
    ) -> Result<Arc<ModelOverrides>, &'static str> {
        self.0
            .provider_models
            .read()
            .await
            .clone()
            .ok_or("Provider model snapshot unavailable")
    }
    pub(crate) async fn effective_model(
        &self,
        tenant: &str,
        provider: &str,
        model: &str,
    ) -> Result<Option<ModelMetadata>, &'static str> {
        let catalog = self.model_catalog().await;
        self.provider_model_overrides()
            .await?
            .model(&catalog, tenant, provider, model)
    }

    async fn save_provider_model(
        &self,
        requested_id: Option<&str>,
        input: ModelInput,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<StoredProviderModel, &'static str> {
        let _mutation = self.0.mutation.lock().await;
        validate_actor(actor)?;
        let tenant = input
            .tenant_id
            .as_deref()
            .or(enforced_tenant)
            .unwrap_or("red");
        validate_id(tenant)?;
        validate_provider(&input.provider)?;
        validate_metadata(&input.metadata)?;
        if enforced_tenant.is_some_and(|allowed| allowed != tenant) {
            return Err("Provider model unavailable");
        }
        if !self
            .0
            .database
            .tenants()
            .await?
            .iter()
            .any(|row| row.id == tenant && row.enabled)
        {
            return Err("Provider model organization is unavailable");
        }
        let id = record_id(tenant, &input.provider, &input.metadata.id);
        if requested_id.is_some_and(|requested| requested != id) {
            return Err(
                "Provider, model ID and organization cannot be changed; create another model",
            );
        }
        let rows = self.0.database.provider_models().await?;
        let existing = rows.iter().find(|row| row.id == id);
        let expected = input
            .revision
            .as_deref()
            .map(|value| value.parse::<i64>().map_err(|_| "Invalid model revision"))
            .transpose()?;
        if requested_id.is_none() && existing.is_some() {
            return Err("Model already exists; reload before editing");
        }
        if requested_id.is_some() && existing.is_none() {
            return Err("Provider model unavailable");
        }
        if existing.map(|row| row.revision) != expected {
            return Err("Provider model changed; reload and retry");
        }
        let record = StoredProviderModel {
            id,
            tenant_id: tenant.to_owned(),
            provider: input.provider,
            metadata: input.metadata,
            hidden: input
                .hidden
                .unwrap_or_else(|| existing.is_some_and(|model| model.hidden)),
            revision: revision()?,
        };
        let catalog = self.model_catalog().await;
        validate_metadata(&overlay(
            catalog.model(&record.provider, &record.metadata.id)?,
            &record.metadata,
        ))?;
        let mut bytes = serde_json::to_vec(&record)
            .map_err(|_| "Invalid model metadata")?
            .len();
        for row in rows.iter().filter(|row| row.id != record.id) {
            bytes += serde_json::to_vec(row)
                .map_err(|_| "Invalid provider model storage")?
                .len();
        }
        if (existing.is_none() && rows.len() >= MAX_MODELS) || bytes > MAX_SNAPSHOT_BYTES {
            return Err("Provider model snapshot exceeds its limit");
        }
        self.0
            .database
            .upsert_provider_model(&record, expected)
            .await?;
        self.refresh_provider_models().await?;
        if let Err(error) = self.refresh_routes().await {
            *self.0.current.write().await = None;
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        self.record_audit_event(
            AuditContext {
                action: "provider.model.upsert",
                actor,
                tenant_id: tenant,
                target: &record.id,
                resource_type: "provider_model",
            },
            existing,
            Some(&record),
        )
        .await;
        Ok(record)
    }
}

pub async fn list(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Query(query): Query<ModelQuery>,
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
        return api_error(StatusCode::NOT_FOUND, "Provider model unavailable");
    }
    let tenant = scope.tenant_id.as_deref().or(query.tenant_id.as_deref());
    let result: Result<_, &'static str> = async {
        let mut rows: Vec<_> = control
            .0
            .database
            .provider_models()
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
            (&a.tenant_id, &a.provider, &a.metadata.id).cmp(&(
                &b.tenant_id,
                &b.provider,
                &b.metadata.id,
            ))
        });
        let total = rows.len();
        let offset = query.offset.unwrap_or(0).min(MAX_MODELS);
        let limit = query.limit.unwrap_or(50).clamp(1, 100);
        let catalog = control.model_catalog().await;
        let models: Vec<_> = rows
            .iter()
            .skip(offset)
            .take(limit)
            .map(|row| view(row, &catalog))
            .collect::<Result<_, _>>()?;
        Ok(serde_json::json!({"models":models,"total":total,"offset":offset,"limit":limit}))
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
            .provider_models()
            .await?
            .into_iter()
            .find(|row| {
                row.id == id
                    && scope
                        .tenant_id
                        .as_ref()
                        .is_none_or(|tenant| *tenant == row.tenant_id)
            })
            .ok_or("Provider model unavailable")?;
        view(&record, control.model_catalog().await.as_ref())
    }
    .await;
    match result {
        Ok(model) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({"model":model})),
        )
            .into_response(),
        Err(error) => failure(error),
    }
}

pub async fn create(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<ModelInput>,
) -> Response {
    save(state, headers, None, input).await
}
pub async fn put(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ModelInput>,
) -> Response {
    save(state, headers, Some(id), input).await
}
async fn save(
    state: ProxyState,
    headers: HeaderMap,
    id: Option<String>,
    input: ModelInput,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .save_provider_model(
            id.as_deref(),
            input,
            &scope.actor,
            scope.tenant_id.as_deref(),
        )
        .await
    {
        Ok(model) => match view(&model, control.model_catalog().await.as_ref()) {
            Ok(view) => (
                [(header::CACHE_CONTROL, "no-store")],
                Json(serde_json::json!({"model":view})),
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
    Query(query): Query<ModelQuery>,
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
            .provider_models()
            .await?
            .into_iter()
            .find(|row| {
                row.id == id
                    && scope
                        .tenant_id
                        .as_ref()
                        .is_none_or(|tenant| *tenant == row.tenant_id)
            })
            .ok_or("Provider model unavailable")?;
        control
            .0
            .database
            .delete_provider_model(&id, &existing.tenant_id, revision)
            .await?;
        control.refresh_provider_models().await?;
        if let Err(error) = control.refresh_routes().await {
            *control.0.current.write().await = None;
            *control.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        control
            .record_audit_event(
                AuditContext {
                    action: "provider.model.delete",
                    actor: &scope.actor,
                    tenant_id: &existing.tenant_id,
                    target: &id,
                    resource_type: "provider_model",
                },
                Some(&existing),
                Option::<&StoredProviderModel>::None,
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

    #[test]
    fn partial_overrides_preserve_limits_and_price_components_and_accept_false_and_zero() {
        let base: ModelMetadata = serde_json::from_value(serde_json::json!({"id":"example","name":"Catalog name","tool_call":true,"limit":{"context":4096,"input":2048,"output":512},"cost":{"input":1,"output":2,"cache_read":0.5}})).unwrap();
        let patch: ModelMetadata = serde_json::from_value(serde_json::json!({"id":"example","name":null,"tool_call":false,"limit":{"output":256},"cost":{"input":0}})).unwrap();
        let result = overlay(Some(base), &patch);
        assert_eq!(result.name.as_deref(), Some("Catalog name"));
        assert_eq!(result.tool_call, Some(false));
        let limit = result.limit.as_ref().unwrap();
        assert_eq!(
            (limit.context, limit.input, limit.output),
            (Some(4096), Some(2048), Some(256))
        );
        let cost = result.cost.as_ref().unwrap();
        assert_eq!(
            (cost.input, cost.output, cost.cache_read),
            (Some(0.0), Some(2.0), Some(0.5))
        );
        assert!(validate_metadata(&result).is_ok());
        for invalid in [
            serde_json::json!({"id":"bad\nmodel"}),
            serde_json::json!({"id":"example","cost":{"input":-1}}),
            serde_json::json!({"id":"example","limit":{"context":128,"input":256}}),
        ] {
            assert!(validate_metadata(&serde_json::from_value(invalid).unwrap()).is_err());
        }
    }

    #[tokio::test]
    async fn metadata_scope_and_revision_checks_prevent_overwrites_and_cross_tenant_reads() {
        let db = Arc::new(
            Database::connect(crate::storage::Backend::Sqlite, "sqlite::memory:")
                .await
                .unwrap(),
        );
        let control = ControlPlane::new(
            db.clone(),
            "model-test-admin-key-12345678901234567890",
            "model-test-storage-key-12345678901234567890",
            true,
        )
        .await
        .unwrap();
        let input = || {
            serde_json::from_value(serde_json::json!({"tenant_id":"red","provider":"private-api","metadata":{"id":"only-red","cost":{"input":3,"output":4}}})).unwrap()
        };
        assert_eq!(
            control
                .save_provider_model(None, input(), "manager:other", Some("other"))
                .await
                .err(),
            Some("Provider model unavailable")
        );
        let row = control
            .save_provider_model(None, input(), "manager:red", Some("red"))
            .await
            .unwrap();
        assert!(control
            .save_provider_model(None, input(), "manager:red", Some("red"))
            .await
            .is_err());
        assert!(control
            .effective_model("red", "private-api", "only-red")
            .await
            .unwrap()
            .is_some());
        assert!(control
            .effective_model("other", "private-api", "only-red")
            .await
            .unwrap()
            .is_none());
        let mut stale = row.clone();
        stale.revision += 1;
        assert!(db
            .upsert_provider_model(&stale, Some(row.revision - 1))
            .await
            .is_err());
        assert!(db
            .delete_provider_model(&row.id, "other", row.revision)
            .await
            .is_err());
        assert!(db
            .delete_provider_model(&row.id, "red", row.revision - 1)
            .await
            .is_err());
        assert_eq!(db.provider_models().await.unwrap().len(), 1);
        db.delete_provider_model(&row.id, "red", row.revision)
            .await
            .unwrap();
        assert!(db
            .upsert_provider_model(&stale, Some(row.revision))
            .await
            .is_err());
        control.refresh_provider_models().await.unwrap();
        assert!(control
            .effective_model("red", "private-api", "only-red")
            .await
            .unwrap()
            .is_none());
    }
}
