//! Lazy, exact-ID access to the bundled anomalyco/models.dev snapshot.
//!
//! Provider transports and credential entitlement remain RedRouter-owned. The
//! public catalog supplies descriptive model metadata only; it never creates a
//! provider, route or authorization grant.

use serde::{Deserialize, Serialize};
#[path = "catalog_search.rs"]
mod search;
pub use search::{CatalogSearch, CatalogSearchModel, CatalogSearchPage};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, OnceLock},
    time::Duration,
};

const BUNDLED_SEED: &str = include_str!("../../../src/lib/catalog/modelsDevSeed.json");
pub(crate) const EXPECTED_SOURCE: &str = "https://models.dev/catalog.json?type=all";
const EXPECTED_REPOSITORY: &str = "https://github.com/anomalyco/models.dev";
const MAX_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogManifest {
    pub schema_version: u64,
    pub transform_version: u64,
    pub source: String,
    pub upstream_repository: String,
    pub upstream_schema_ref: String,
    pub fetched_at: String,
    pub etag: Option<String>,
    pub source_sha256: String,
    pub content_sha256: String,
    pub license: String,
    pub providers: usize,
    pub provider_models: usize,
    pub canonical_models: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CatalogCost {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_audio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_audio: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CatalogLimit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CatalogModalities {
    #[serde(default)]
    pub input: Vec<String>,
    #[serde(default)]
    pub output: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum CatalogInterleaved {
    Enabled(bool),
    Field { field: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CatalogReasoningOption {
    Toggle,
    Effort {
        values: Vec<Option<String>>,
    },
    BudgetTokens {
        #[serde(skip_serializing_if = "Option::is_none")]
        min: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max: Option<u64>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModelMetadata {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub knowledge: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_output: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_weights: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modalities: Option<CatalogModalities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<CatalogLimit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<CatalogCost>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interleaved: Option<CatalogInterleaved>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_options: Option<Vec<CatalogReasoningOption>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Seed {
    manifest: CatalogManifest,
    providers: BTreeMap<String, Box<RawValue>>,
    models: BTreeMap<String, ModelMetadata>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SeedEnvelope<'a> {
    manifest: CatalogManifest,
    #[serde(borrow)]
    providers: &'a RawValue,
    #[serde(borrow)]
    models: &'a RawValue,
}

#[derive(Deserialize, Serialize)]
struct ProviderModels {
    id: String,
    name: Option<String>,
    #[serde(default)]
    models: BTreeMap<String, ModelMetadata>,
}

#[derive(Deserialize)]
struct ProviderHeader<'a> {
    id: &'a str,
    name: Option<&'a str>,
    #[serde(borrow, rename = "models")]
    _models: &'a RawValue,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct CatalogProviderSummary {
    pub id: String,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct CatalogProvider {
    pub id: String,
    pub name: Option<String>,
    pub models: Vec<ModelMetadata>,
}

struct LazyProvider {
    id: Box<str>,
    raw: Arc<str>,
    parsed: OnceLock<Result<Arc<ProviderModels>, &'static str>>,
}

impl LazyProvider {
    fn parsed(&self) -> Result<&ProviderModels, &'static str> {
        self.parsed
            .get_or_init(|| {
                let provider: ProviderModels = serde_json::from_str(self.raw.as_ref())
                    .map_err(|_| "invalid models.dev provider")?;
                if provider.id != self.id.as_ref() || provider.models.len() > 100_000 {
                    return Err("invalid models.dev provider identity");
                }
                for (id, model) in &provider.models {
                    if id != &model.id || !valid_identifier(id) || !valid_metadata(model) {
                        return Err("invalid models.dev model metadata");
                    }
                }
                Ok(Arc::new(provider))
            })
            .as_ref()
            .map(Arc::as_ref)
            .map_err(|error| *error)
    }
}

pub struct ModelCatalog {
    manifest: CatalogManifest,
    providers: HashMap<Box<str>, Arc<LazyProvider>>,
}

impl ModelCatalog {
    fn bundled() -> Result<Self, &'static str> {
        Self::from_snapshot(BUNDLED_SEED)
    }

    pub(crate) fn from_snapshot(snapshot: &str) -> Result<Self, &'static str> {
        if snapshot.len() > MAX_SNAPSHOT_BYTES {
            return Err("models.dev snapshot is too large");
        }
        let envelope: SeedEnvelope<'_> =
            serde_json::from_str(snapshot).map_err(|_| "invalid bundled models.dev catalog")?;
        let mut content_hash = Sha256::new();
        content_hash.update(b"{\"providers\":");
        content_hash.update(envelope.providers.get().as_bytes());
        content_hash.update(b",\"models\":");
        content_hash.update(envelope.models.get().as_bytes());
        content_hash.update(b"}");
        if !hex::encode(content_hash.finalize())
            .eq_ignore_ascii_case(&envelope.manifest.content_sha256)
        {
            return Err("invalid models.dev content hash");
        }
        let seed: Seed =
            serde_json::from_str(snapshot).map_err(|_| "invalid bundled models.dev catalog")?;
        if seed.manifest.schema_version != 1
            || seed.manifest.transform_version != 2
            || seed.manifest.source != EXPECTED_SOURCE
            || seed.manifest.upstream_repository != EXPECTED_REPOSITORY
            || seed.manifest.license != "MIT"
            || seed.manifest.providers != seed.providers.len()
            || !valid_sha256(&seed.manifest.source_sha256)
            || !valid_sha256(&seed.manifest.content_sha256)
            || !valid_git_sha(&seed.manifest.upstream_schema_ref)
        {
            return Err("invalid bundled models.dev manifest");
        }
        if seed.manifest.canonical_models != seed.models.len() {
            return Err("invalid models.dev canonical model count");
        }
        for (id, model) in &seed.models {
            if id != &model.id || !valid_identifier(id) || !valid_metadata(model) {
                return Err("invalid models.dev canonical model metadata");
            }
        }
        let mut providers = HashMap::with_capacity(seed.providers.len());
        let mut provider_models = 0_usize;
        for (id, raw) in seed.providers {
            if !valid_identifier(&id) {
                return Err("invalid models.dev provider identifier");
            }
            let header: ProviderHeader<'_> =
                serde_json::from_str(raw.get()).map_err(|_| "invalid models.dev provider")?;
            if header.id != id || header.name.is_some_and(|name| name.len() > 4_096) {
                return Err("invalid models.dev provider identity");
            }
            let models: HashMap<&str, &RawValue> = serde_json::from_str(header._models.get())
                .map_err(|_| "invalid models.dev provider models")?;
            if models.keys().any(|model| !valid_identifier(model)) {
                return Err("invalid models.dev model identifier");
            }
            provider_models = provider_models
                .checked_add(models.len())
                .ok_or("invalid models.dev provider model count")?;
            let provider = Arc::new(LazyProvider {
                id: Box::from(id.as_str()),
                raw: Arc::from(raw.get()),
                parsed: OnceLock::new(),
            });
            if providers.insert(Box::from(id), provider).is_some() {
                return Err("duplicate models.dev provider");
            }
        }
        if seed.manifest.provider_models != provider_models {
            return Err("invalid models.dev provider model count");
        }
        Ok(Self {
            manifest: seed.manifest,
            providers,
        })
    }

    pub(crate) fn validate_all(&self) -> Result<(), &'static str> {
        for provider in self.providers.values() {
            provider.parsed()?;
        }
        Ok(())
    }

    pub fn manifest(&self) -> &CatalogManifest {
        &self.manifest
    }

    /// The upstream models.dev provider namespace. This index does not parse
    /// any provider's model map.
    pub fn provider_summaries(&self) -> Result<Vec<CatalogProviderSummary>, &'static str> {
        let mut summaries = Vec::with_capacity(self.providers.len());
        for (id, provider) in &self.providers {
            let header: ProviderHeader<'_> = serde_json::from_str(provider.raw.as_ref())
                .map_err(|_| "invalid models.dev provider")?;
            if header.id != id.as_ref() {
                return Err("invalid models.dev provider identity");
            }
            summaries.push(CatalogProviderSummary {
                id: header.id.to_owned(),
                name: header.name.map(str::to_owned),
            });
        }
        summaries.sort_unstable_by(|left, right| left.id.cmp(&right.id));
        Ok(summaries)
    }

    /// Full metadata for one exact upstream provider. Other providers stay
    /// serialized in the bundled snapshot and consume no model-map storage.
    pub fn provider(&self, id: &str) -> Result<Option<CatalogProvider>, &'static str> {
        if !valid_identifier(id) {
            return Ok(None);
        }
        let Some(provider) = self.providers.get(id) else {
            return Ok(None);
        };
        let parsed = provider.parsed()?;
        let mut models = parsed.models.values().cloned().collect::<Vec<_>>();
        models.sort_unstable_by(|left, right| left.id.cmp(&right.id));
        Ok(Some(CatalogProvider {
            id: parsed.id.clone(),
            name: parsed.name.clone(),
            models,
        }))
    }

    /// Descriptive model inventory for an already configured provider. A
    /// catalog entry does not create an account or grant inference access.
    pub(crate) fn models_for_provider<'a>(
        &'a self,
        local_provider: &str,
    ) -> Result<BTreeMap<&'a str, &'a ModelMetadata>, &'static str> {
        if !valid_identifier(local_provider) {
            return Ok(BTreeMap::new());
        }
        let aliases = upstream_provider_aliases(local_provider);
        let candidates = if aliases.is_empty() {
            std::slice::from_ref(&local_provider)
        } else {
            aliases
        };
        let mut result = BTreeMap::new();
        let mut ambiguous = std::collections::HashSet::new();
        for upstream in candidates {
            let Some(provider) = self.providers.get(*upstream) else {
                continue;
            };
            for (id, model) in &provider.parsed()?.models {
                if ambiguous.contains(id.as_str()) {
                    continue;
                }
                if result
                    .get(id.as_str())
                    .is_some_and(|previous| *previous != model)
                {
                    result.remove(id.as_str());
                    ambiguous.insert(id.as_str());
                } else {
                    result.insert(id.as_str(), model);
                }
            }
        }
        Ok(result)
    }

    /// Exact native model lookup. Provider aliases identify only the same
    /// commercial deployment; canonical model IDs never authorize dispatch.
    pub fn model(
        &self,
        local_provider: &str,
        native_model: &str,
    ) -> Result<Option<ModelMetadata>, &'static str> {
        if !valid_identifier(local_provider) || !valid_identifier(native_model) {
            return Ok(None);
        }
        let aliases = upstream_provider_aliases(local_provider);
        let candidates = if aliases.is_empty() {
            std::slice::from_ref(&local_provider)
        } else {
            aliases
        };
        let mut found = None;
        for upstream in candidates {
            let Some(provider) = self.providers.get(*upstream) else {
                continue;
            };
            let Some(model) = provider.parsed()?.models.get(native_model) else {
                continue;
            };
            if found.as_ref().is_some_and(|previous| previous != model) {
                return Err("ambiguous models.dev provider mapping");
            }
            found = Some(model.clone());
        }
        Ok(found)
    }
}

pub fn bundled_catalog() -> Result<Arc<ModelCatalog>, &'static str> {
    static CATALOG: OnceLock<Result<Arc<ModelCatalog>, &'static str>> = OnceLock::new();
    CATALOG
        .get_or_init(|| ModelCatalog::bundled().map(Arc::new))
        .as_ref()
        .map(Arc::clone)
        .map_err(|error| *error)
}

pub(crate) enum CatalogRefresh {
    NotModified,
    Updated {
        catalog: Arc<ModelCatalog>,
        snapshot_json: String,
    },
}

#[derive(Serialize)]
struct CatalogContent<'a> {
    providers: &'a BTreeMap<String, ProviderModels>,
    models: &'a BTreeMap<String, ModelMetadata>,
}

#[derive(Serialize)]
struct CatalogSnapshot<'a> {
    manifest: CatalogManifest,
    providers: &'a BTreeMap<String, ProviderModels>,
    models: &'a BTreeMap<String, ModelMetadata>,
}

pub(crate) async fn refresh_from_source(
    client: &reqwest::Client,
    source: &reqwest::Url,
    etag: Option<&str>,
    schema_ref: &str,
) -> Result<CatalogRefresh, &'static str> {
    use futures_util::StreamExt as _;
    let mut request = client.get(source.clone());
    if let Some(etag) = etag.filter(|value| value.len() <= 1_024) {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let response = tokio::time::timeout(Duration::from_secs(30), request.send())
        .await
        .map_err(|_| "models.dev request timed out")?
        .map_err(|_| "models.dev request failed")?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(CatalogRefresh::NotModified);
    }
    if !response.status().is_success() {
        return Err("models.dev request failed");
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_SNAPSHOT_BYTES as u64)
    {
        return Err("models.dev response is too large");
    }
    let response_etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 1_024)
        .map(str::to_owned);
    let body = tokio::time::timeout(Duration::from_secs(30), async move {
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "models.dev response failed")?;
            if body.len().saturating_add(chunk.len()) > MAX_SNAPSHOT_BYTES {
                return Err("models.dev response is too large");
            }
            body.extend_from_slice(&chunk);
        }
        Ok::<_, &'static str>(body)
    })
    .await
    .map_err(|_| "models.dev response timed out")??;
    let schema_ref = schema_ref.to_owned();
    tokio::task::spawn_blocking(move || -> Result<CatalogRefresh, &'static str> {
        let snapshot_json = normalize_source(&body, response_etag, &schema_ref)?;
        // Validate every provider before publication, but do it on a disposable
        // instance. Publishing that instance would retain every parsed provider
        // and defeat the catalog's lazy-memory design.
        ModelCatalog::from_snapshot(&snapshot_json)?.validate_all()?;
        let catalog = Arc::new(ModelCatalog::from_snapshot(&snapshot_json)?);
        Ok(CatalogRefresh::Updated {
            catalog,
            snapshot_json,
        })
    })
    .await
    .map_err(|_| "models.dev normalization failed")?
}

fn normalize_source(
    body: &[u8],
    etag: Option<String>,
    schema_ref: &str,
) -> Result<String, &'static str> {
    if !valid_git_sha(schema_ref) {
        return Err("invalid models.dev schema reference");
    }
    let raw: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "invalid models.dev response")?;
    let object = raw.as_object().ok_or("invalid models.dev response")?;
    let providers = object
        .get("providers")
        .and_then(serde_json::Value::as_object)
        .ok_or("invalid models.dev providers")?;
    let canonical = object
        .get("models")
        .and_then(serde_json::Value::as_object)
        .ok_or("invalid models.dev canonical models")?;
    let mut normalized_providers = BTreeMap::new();
    let mut provider_models = 0_usize;
    for (id, value) in providers {
        if !valid_identifier(id) {
            return Err("invalid models.dev provider identifier");
        }
        let provider = value.as_object().ok_or("invalid models.dev provider")?;
        if provider.get("id").and_then(serde_json::Value::as_str) != Some(id.as_str()) {
            return Err("invalid models.dev provider identity");
        }
        let models = provider
            .get("models")
            .and_then(serde_json::Value::as_object)
            .ok_or("invalid models.dev provider models")?;
        let mut normalized_models = BTreeMap::new();
        for (model_id, model) in models {
            normalized_models.insert(model_id.clone(), normalize_model(model_id, model)?);
        }
        provider_models = provider_models
            .checked_add(normalized_models.len())
            .ok_or("invalid models.dev provider model count")?;
        normalized_providers.insert(
            id.clone(),
            ProviderModels {
                id: id.clone(),
                name: provider
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| Some(id.clone())),
                models: normalized_models,
            },
        );
    }
    let mut normalized_models = BTreeMap::new();
    for (id, model) in canonical {
        normalized_models.insert(id.clone(), normalize_model(id, model)?);
    }
    if normalized_providers.is_empty() || provider_models == 0 || normalized_models.is_empty() {
        return Err("models.dev catalog is empty");
    }
    let content = CatalogContent {
        providers: &normalized_providers,
        models: &normalized_models,
    };
    let content_json =
        serde_json::to_vec(&content).map_err(|_| "cannot encode models.dev catalog")?;
    let fetched_at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| "cannot timestamp models.dev catalog")?;
    let manifest = CatalogManifest {
        schema_version: 1,
        transform_version: 2,
        source: EXPECTED_SOURCE.to_owned(),
        upstream_repository: EXPECTED_REPOSITORY.to_owned(),
        upstream_schema_ref: schema_ref.to_owned(),
        fetched_at,
        etag,
        source_sha256: hex::encode(Sha256::digest(body)),
        content_sha256: hex::encode(Sha256::digest(&content_json)),
        license: "MIT".to_owned(),
        providers: normalized_providers.len(),
        provider_models,
        canonical_models: normalized_models.len(),
    };
    serde_json::to_string(&CatalogSnapshot {
        manifest,
        providers: &normalized_providers,
        models: &normalized_models,
    })
    .map_err(|_| "cannot encode models.dev snapshot")
}

fn normalize_model(id: &str, value: &serde_json::Value) -> Result<ModelMetadata, &'static str> {
    if !valid_identifier(id) {
        return Err("invalid models.dev model identifier");
    }
    let value = value.as_object().ok_or("invalid models.dev model")?;
    if value
        .get("id")
        .is_some_and(|stored| stored.as_str() != Some(id))
    {
        return Err("models.dev model identity mismatch");
    }
    let string = |field: &str| {
        value
            .get(field)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    let flag = |field: &str| value.get(field).and_then(serde_json::Value::as_bool);
    let modalities = value
        .get("modalities")
        .and_then(serde_json::Value::as_object)
        .map(|modalities| CatalogModalities {
            input: string_array(modalities.get("input")),
            output: string_array(modalities.get("output")),
        });
    let limit = value
        .get("limit")
        .and_then(serde_json::Value::as_object)
        .map(|limit| -> Result<CatalogLimit, &'static str> {
            Ok(CatalogLimit {
                context: optional_u64(limit.get("context"))?,
                input: optional_u64(limit.get("input"))?,
                output: optional_u64(limit.get("output"))?,
            })
        })
        .transpose()?;
    let cost = value
        .get("cost")
        .and_then(serde_json::Value::as_object)
        .map(|cost| -> Result<CatalogCost, &'static str> {
            Ok(CatalogCost {
                input: optional_cost(cost.get("input"))?,
                output: optional_cost(cost.get("output"))?,
                reasoning: optional_cost(cost.get("reasoning"))?,
                cache_read: optional_cost(cost.get("cache_read"))?,
                cache_write: optional_cost(cost.get("cache_write"))?,
                input_audio: optional_cost(cost.get("input_audio"))?,
                output_audio: optional_cost(cost.get("output_audio"))?,
            })
        })
        .transpose()?;
    let interleaved = match value.get("interleaved") {
        Some(serde_json::Value::Bool(enabled)) => Some(CatalogInterleaved::Enabled(*enabled)),
        Some(serde_json::Value::Object(object)) => object
            .get("field")
            .and_then(serde_json::Value::as_str)
            .map(|field| CatalogInterleaved::Field {
                field: field.to_owned(),
            }),
        _ => None,
    };
    let reasoning_options = value
        .get("reasoning_options")
        .and_then(serde_json::Value::as_array)
        .map(|options| {
            options
                .iter()
                .map(normalize_reasoning_option)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    let model = ModelMetadata {
        id: id.to_owned(),
        name: string("name"),
        r#type: string("type"),
        canonical_model_id: string("canonical_model_id"),
        family: string("family"),
        knowledge: string("knowledge"),
        release_date: string("release_date"),
        last_updated: string("last_updated"),
        status: string("status"),
        attachment: flag("attachment"),
        reasoning: flag("reasoning"),
        tool_call: flag("tool_call"),
        structured_output: flag("structured_output"),
        temperature: flag("temperature"),
        open_weights: flag("open_weights"),
        modalities,
        limit,
        cost,
        interleaved,
        reasoning_options,
    };
    if !valid_metadata(&model) {
        return Err("invalid models.dev model metadata");
    }
    Ok(model)
}

fn string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn optional_u64(value: Option<&serde_json::Value>) -> Result<Option<u64>, &'static str> {
    value
        .map(|value| value.as_u64().ok_or("invalid models.dev model limit"))
        .transpose()
}

fn optional_cost(value: Option<&serde_json::Value>) -> Result<Option<f64>, &'static str> {
    value
        .map(|value| {
            value
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0)
                .ok_or("invalid models.dev model cost")
        })
        .transpose()
}

fn normalize_reasoning_option(
    value: &serde_json::Value,
) -> Result<CatalogReasoningOption, &'static str> {
    let value = value
        .as_object()
        .ok_or("invalid models.dev reasoning option")?;
    match value.get("type").and_then(serde_json::Value::as_str) {
        Some("toggle") => Ok(CatalogReasoningOption::Toggle),
        Some("effort") => {
            let values = value
                .get("values")
                .and_then(serde_json::Value::as_array)
                .ok_or("invalid models.dev reasoning effort")?
                .iter()
                .map(|value| match value {
                    serde_json::Value::Null => Ok(None),
                    serde_json::Value::String(value) => Ok(Some(value.clone())),
                    _ => Err("invalid models.dev reasoning effort"),
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(CatalogReasoningOption::Effort { values })
        }
        Some("budget_tokens") => {
            let min = value
                .get("min")
                .map(|value| {
                    value
                        .as_i64()
                        .filter(|value| *value >= -1)
                        .ok_or("invalid models.dev reasoning budget")
                })
                .transpose()?;
            let max = optional_u64(value.get("max"))?;
            if min
                .zip(max)
                .is_some_and(|(min, max)| min >= 0 && min as u64 > max)
            {
                return Err("invalid models.dev reasoning budget");
            }
            Ok(CatalogReasoningOption::BudgetTokens { min, max })
        }
        _ => Err("unknown models.dev reasoning option"),
    }
}

fn upstream_provider_aliases(provider: &str) -> &'static [&'static str] {
    match provider {
        "gemini" | "agy" | "antigravity" => &["google"],
        "vertex" => &["google-vertex", "vertex_ai"],
        "vertex-partner" | "vp" => &["google-vertex-anthropic"],
        "together" => &["togetherai", "together_ai"],
        "fireworks" => &["fireworks-ai", "fireworks"],
        "pplx" | "perplexity" => &["perplexity"],
        "moonshot" | "kimi" => &["moonshotai", "moonshot"],
        "hf" | "huggingface" => &["huggingface"],
        "ollamacloud" | "ollama-cloud" => &["ollama"],
        "github" | "gh" => &["github-copilot"],
        "github-models" => &["github"],
        "kilocode" | "kc" | "kilo-gateway" => &["kilo", "kilocode"],
        "kimi-coding" | "kmc" | "kimi-coding-apikey" | "kmca" => &["kimi-for-coding"],
        "opencode" | "opencode-zen" => &["opencode"],
        "ali" | "alibaba" => &["alibaba"],
        "ali-cn" | "alibaba-cn" | "alibaba-china" => &["alibaba-cn"],
        "bcp" | "bailian-coding-plan" => &["alibaba-coding-plan"],
        "glm" | "glmt" => &["zai-coding-plan"],
        "lc" | "longcat" => &["longcat"],
        "pol" | "pollinations" => &["pollinations"],
        "cf" => &["cloudflare"],
        "scw" => &["scaleway"],
        "bb" | "blackbox" => &["blackbox"],
        "cl" | "cline" => &["cline"],
        "cu" | "cursor" => &["cursor"],
        "openai" => &["openai"],
        "anthropic" => &["anthropic"],
        "openrouter" => &["openrouter"],
        "groq" => &["groq"],
        "cerebras" => &["cerebras"],
        "mistral" => &["mistral"],
        "deepseek" => &["deepseek"],
        "xai" => &["xai"],
        "nvidia" => &["nvidia"],
        "ai21" => &["ai21"],
        "siliconflow" => &["siliconflow"],
        _ => &[],
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1_024
        && !value.bytes().any(|byte| byte < b' ' || byte == 0x7f)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_git_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_metadata(model: &ModelMetadata) -> bool {
    let valid_cost =
        |value: Option<f64>| value.is_none_or(|value| value.is_finite() && value >= 0.0);
    model.cost.as_ref().is_none_or(|cost| {
        [
            cost.input,
            cost.output,
            cost.reasoning,
            cost.cache_read,
            cost.cache_write,
            cost.input_audio,
            cost.output_audio,
        ]
        .into_iter()
        .all(valid_cost)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_catalog_is_lazy_exact_and_provider_scoped() {
        let catalog = bundled_catalog().unwrap();
        assert!(catalog.manifest().providers > 100);
        assert_eq!(catalog.manifest().upstream_repository, EXPECTED_REPOSITORY);
        let model = catalog
            .model("xai", "grok-4.20-0309-non-reasoning")
            .unwrap()
            .unwrap();
        assert_eq!(model.limit.unwrap().context, Some(1_000_000));
        assert!(catalog
            .model("xai", "GROK-4.20-0309-NON-REASONING")
            .unwrap()
            .is_none());
        assert!(catalog
            .model("openai", "grok-4.20-0309-non-reasoning")
            .unwrap()
            .is_none());
        let provider = catalog.provider("openai").unwrap().unwrap();
        assert_eq!(provider.name.as_deref(), Some("OpenAI"));
        assert!(provider
            .models
            .windows(2)
            .all(|models| models[0].id < models[1].id));
        assert!(catalog.provider("OpenAI").unwrap().is_none());
        let inventory = catalog.models_for_provider("openai").unwrap();
        assert_eq!(
            inventory.get("gpt-4o").copied(),
            catalog.model("openai", "gpt-4o").unwrap().as_ref()
        );
        assert!(catalog
            .models_for_provider("not-a-provider")
            .unwrap()
            .is_empty());
        let summaries = catalog.provider_summaries().unwrap();
        assert_eq!(summaries.len(), catalog.manifest().providers);
        assert_eq!(summaries[0].id, "302ai");
        assert!(summaries
            .iter()
            .any(|provider| provider.id == "openai" && provider.name.as_deref() == Some("OpenAI")));
    }

    #[test]
    fn antigravity_uses_the_models_dev_google_namespace() {
        assert_eq!(upstream_provider_aliases("agy"), &["google"]);
        assert_eq!(upstream_provider_aliases("antigravity"), &["google"]);
        let catalog = bundled_catalog().unwrap();
        assert_eq!(
            catalog.models_for_provider("antigravity").unwrap().len(),
            catalog.provider("google").unwrap().unwrap().models.len()
        );
    }

    #[test]
    fn catalog_rejects_content_changed_without_a_matching_manifest() {
        let tampered = BUNDLED_SEED.replacen("MiniMax-M1", "MiniMax-X1", 1);
        assert!(matches!(
            ModelCatalog::from_snapshot(&tampered),
            Err("invalid models.dev content hash")
        ));
    }
}
