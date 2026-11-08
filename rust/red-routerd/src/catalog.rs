//! Lazy, exact-ID access to the bundled anomalyco/models.dev snapshot.
//!
//! Provider transports and credential entitlement remain RedRouter-owned. The
//! public catalog supplies descriptive model metadata only; it never creates a
//! provider, route or authorization grant.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
};

const BUNDLED_SEED: &str = include_str!("../../../src/lib/catalog/modelsDevSeed.json");
const EXPECTED_SOURCE: &str = "https://models.dev/catalog.json?type=all";
const EXPECTED_REPOSITORY: &str = "https://github.com/anomalyco/models.dev";

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
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub reasoning: Option<f64>,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
    pub input_audio: Option<f64>,
    pub output_audio: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CatalogLimit {
    pub context: Option<u64>,
    pub input: Option<u64>,
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
    Effort { values: Vec<Option<String>> },
    BudgetTokens { min: Option<i64>, max: Option<u64> },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModelMetadata {
    pub id: String,
    pub name: Option<String>,
    pub r#type: Option<String>,
    pub canonical_model_id: Option<String>,
    pub family: Option<String>,
    pub knowledge: Option<String>,
    pub release_date: Option<String>,
    pub last_updated: Option<String>,
    pub status: Option<String>,
    pub attachment: Option<bool>,
    pub reasoning: Option<bool>,
    pub tool_call: Option<bool>,
    pub structured_output: Option<bool>,
    pub temperature: Option<bool>,
    pub open_weights: Option<bool>,
    pub modalities: Option<CatalogModalities>,
    pub limit: Option<CatalogLimit>,
    pub cost: Option<CatalogCost>,
    pub interleaved: Option<CatalogInterleaved>,
    pub reasoning_options: Option<Vec<CatalogReasoningOption>>,
}

#[derive(Deserialize)]
struct Seed<'a> {
    manifest: CatalogManifest,
    #[serde(borrow)]
    providers: HashMap<&'a str, &'a RawValue>,
}

#[derive(Deserialize)]
struct ProviderModels {
    id: String,
    name: Option<String>,
    #[serde(default)]
    models: HashMap<String, ModelMetadata>,
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
    raw: &'static RawValue,
    parsed: OnceLock<Result<Arc<ProviderModels>, &'static str>>,
}

impl LazyProvider {
    fn parsed(&self) -> Result<&ProviderModels, &'static str> {
        self.parsed
            .get_or_init(|| {
                let provider: ProviderModels = serde_json::from_str(self.raw.get())
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
        let seed: Seed<'static> =
            serde_json::from_str(BUNDLED_SEED).map_err(|_| "invalid bundled models.dev catalog")?;
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
        let mut providers = HashMap::with_capacity(seed.providers.len());
        for (id, raw) in seed.providers {
            if !valid_identifier(id) {
                return Err("invalid models.dev provider identifier");
            }
            let provider = Arc::new(LazyProvider {
                id: Box::from(id),
                raw,
                parsed: OnceLock::new(),
            });
            if providers.insert(Box::from(id), provider).is_some() {
                return Err("duplicate models.dev provider");
            }
        }
        Ok(Self {
            manifest: seed.manifest,
            providers,
        })
    }

    pub fn manifest(&self) -> &CatalogManifest {
        &self.manifest
    }

    /// The upstream models.dev provider namespace. This index does not parse
    /// any provider's model map.
    pub fn provider_summaries(&self) -> Result<Vec<CatalogProviderSummary>, &'static str> {
        let mut summaries = Vec::with_capacity(self.providers.len());
        for (id, provider) in &self.providers {
            let header: ProviderHeader<'_> = serde_json::from_str(provider.raw.get())
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

pub fn bundled_catalog() -> Result<&'static ModelCatalog, &'static str> {
    static CATALOG: OnceLock<Result<ModelCatalog, &'static str>> = OnceLock::new();
    CATALOG
        .get_or_init(ModelCatalog::bundled)
        .as_ref()
        .map_err(|error| *error)
}

fn upstream_provider_aliases(provider: &str) -> &'static [&'static str] {
    match provider {
        "gemini" => &["google"],
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
        let summaries = catalog.provider_summaries().unwrap();
        assert_eq!(summaries.len(), catalog.manifest().providers);
        assert_eq!(summaries[0].id, "302ai");
        assert!(summaries
            .iter()
            .any(|provider| provider.id == "openai" && provider.name.as_deref() == Some("OpenAI")));
    }
}
