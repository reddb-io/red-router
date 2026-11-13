//! Bounded responses across the immutable models.dev snapshot. Search does not
//! populate every LazyProvider cache or copy every model into a response buffer.
use super::{valid_metadata, ModelCatalog, ModelMetadata, ProviderHeader};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
};

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CatalogSearch {
    pub query: String,
    pub provider: String,
    pub model_type: String,
    pub capability: String,
    pub input_modality: String,
    pub min_context: u64,
    pub sort: String,
    pub descending: bool,
    pub offset: usize,
    pub limit: Option<usize>,
    pub snapshot: Option<String>,
}

impl CatalogSearch {
    pub fn validate(&self) -> Result<(), &'static str> {
        if [
            self.query.as_str(),
            self.provider.as_str(),
            self.model_type.as_str(),
            self.input_modality.as_str(),
        ]
        .iter()
        .any(|value| value.len() > 256 || value.chars().any(char::is_control))
            || self.limit.is_some_and(|limit| limit == 0 || limit > 100)
            || !matches!(
                self.sort.as_str(),
                "" | "id" | "context" | "output" | "input-price" | "output-price"
            )
            || !matches!(
                self.capability.as_str(),
                "" | "reasoning"
                    | "tool_call"
                    | "structured_output"
                    | "attachment"
                    | "temperature"
                    | "open_weights"
            )
            || self
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| !super::valid_sha256(snapshot))
        {
            return Err("invalid catalog search");
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct CatalogSearchModel {
    pub provider_id: String,
    pub provider_name: Option<String>,
    #[serde(flatten)]
    pub model: ModelMetadata,
}

#[derive(Debug, Serialize)]
pub struct CatalogSearchPage {
    pub models: Vec<CatalogSearchModel>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub content_sha256: String,
    pub types: BTreeSet<String>,
    pub input_modalities: BTreeSet<String>,
}

struct Candidate<'a> {
    provider: &'a str,
    name: Option<&'a str>,
    id: &'a str,
    raw: &'a RawValue,
    count: Option<u64>,
    price: Option<f64>,
}

fn optional_order<T>(
    a: Option<T>,
    b: Option<T>,
    compare: impl Fn(T, T) -> Ordering,
    descending: bool,
) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => {
            let order = compare(a, b);
            if descending {
                order.reverse()
            } else {
                order
            }
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        _ => Ordering::Equal,
    }
}

fn matches(
    model: &ModelMetadata,
    query: &CatalogSearch,
    text: &str,
    provider: &str,
    name: Option<&str>,
) -> bool {
    if (!query.model_type.is_empty() && model.r#type.as_deref() != Some(query.model_type.as_str()))
        || (query.min_context > 0
            && model
                .limit
                .as_ref()
                .and_then(|limit| limit.context)
                .unwrap_or(0)
                < query.min_context)
        || (!query.input_modality.is_empty()
            && !model
                .modalities
                .as_ref()
                .is_some_and(|modalities| modalities.input.contains(&query.input_modality)))
    {
        return false;
    }
    let capabilities = [
        ("reasoning", "Reasoning", model.reasoning),
        ("tool_call", "Tools", model.tool_call),
        (
            "structured_output",
            "Structured output",
            model.structured_output,
        ),
        ("attachment", "Attachments", model.attachment),
        ("temperature", "Temperature", model.temperature),
        ("open_weights", "Open weights", model.open_weights),
    ];
    if !query.capability.is_empty()
        && !capabilities
            .iter()
            .any(|(id, _, enabled)| *id == query.capability && *enabled == Some(true))
    {
        return false;
    }
    if text.is_empty() {
        return true;
    }
    let mut words = vec![
        provider,
        name.unwrap_or(""),
        &model.id,
        model.name.as_deref().unwrap_or(""),
        model.r#type.as_deref().unwrap_or(""),
        model.family.as_deref().unwrap_or(""),
        model.status.as_deref().unwrap_or(""),
        model.canonical_model_id.as_deref().unwrap_or(""),
    ];
    if let Some(modalities) = &model.modalities {
        words.extend(
            modalities
                .input
                .iter()
                .chain(&modalities.output)
                .map(String::as_str),
        );
    }
    words.extend(
        capabilities
            .iter()
            .filter(|(_, _, enabled)| *enabled == Some(true))
            .map(|(_, label, _)| *label),
    );
    words.join(" ").to_lowercase().contains(text)
}

impl ModelCatalog {
    pub fn search(&self, query: &CatalogSearch) -> Result<CatalogSearchPage, &'static str> {
        query.validate()?;
        if query
            .snapshot
            .as_ref()
            .is_some_and(|hash| hash != &self.manifest.content_sha256)
        {
            return Err("catalog snapshot changed");
        }
        let mut candidates = Vec::new();
        let mut types = BTreeSet::new();
        let mut input_modalities = BTreeSet::new();
        let text = query.query.trim().to_lowercase();
        for (provider_id, provider) in &self.providers {
            if !query.provider.is_empty() && query.provider != provider_id.as_ref() {
                continue;
            }
            let header: ProviderHeader<'_> =
                serde_json::from_str(&provider.raw).map_err(|_| "invalid catalog provider")?;
            let models: BTreeMap<&str, &RawValue> =
                serde_json::from_str(header._models.get()).map_err(|_| "invalid catalog models")?;
            for (id, raw) in models {
                let model: ModelMetadata =
                    serde_json::from_str(raw.get()).map_err(|_| "invalid catalog model")?;
                if model.id != id || !valid_metadata(&model) {
                    return Err("invalid catalog model");
                }
                if let Some(kind) = &model.r#type {
                    types.insert(kind.clone());
                }
                if let Some(modalities) = &model.modalities {
                    input_modalities.extend(modalities.input.iter().cloned());
                }
                if !matches(&model, query, &text, provider_id, header.name) {
                    continue;
                }
                candidates.push(Candidate {
                    provider: provider_id,
                    name: header.name,
                    id,
                    raw,
                    count: model.limit.as_ref().and_then(|limit| {
                        if query.sort == "output" {
                            limit.output
                        } else {
                            limit.context
                        }
                    }),
                    price: model.cost.as_ref().and_then(|cost| {
                        if query.sort == "output-price" {
                            cost.output
                        } else {
                            cost.input
                        }
                    }),
                });
            }
        }
        candidates.sort_unstable_by(|a, b| {
            let order = match query.sort.as_str() {
                "context" | "output" => {
                    optional_order(a.count, b.count, |a, b| a.cmp(&b), query.descending)
                }
                "input-price" | "output-price" => {
                    optional_order(a.price, b.price, |a, b| a.total_cmp(&b), query.descending)
                }
                _ => {
                    if query.descending {
                        b.id.cmp(a.id)
                    } else {
                        a.id.cmp(b.id)
                    }
                }
            };
            order
                .then_with(|| a.id.cmp(b.id))
                .then_with(|| a.provider.cmp(b.provider))
        });
        let limit = query.limit.unwrap_or(50);
        // Clamp stale page offsets after filtering without offset arithmetic overflow.
        let offset = query
            .offset
            .min(candidates.len().saturating_sub(1) / limit * limit);
        let models = candidates
            .iter()
            .skip(offset)
            .take(limit)
            .map(|candidate| {
                Ok(CatalogSearchModel {
                    provider_id: candidate.provider.to_owned(),
                    provider_name: candidate.name.map(str::to_owned),
                    model: serde_json::from_str(candidate.raw.get())
                        .map_err(|_| "invalid catalog model")?,
                })
            })
            .collect::<Result<Vec<_>, &'static str>>()?;
        Ok(CatalogSearchPage {
            models,
            total: candidates.len(),
            offset,
            limit,
            content_sha256: self.manifest.content_sha256.clone(),
            types,
            input_modalities,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{bundled_catalog, LazyProvider};
    use std::sync::{Arc, OnceLock};

    fn fixture() -> ModelCatalog {
        let providers = [
            ("zeta", serde_json::json!({"id":"zeta","name":"Zeta AI","models":{
                "shared":{"id":"shared","type":"chat","reasoning":true,"limit":{"context":200000},"cost":{"input":2},"modalities":{"input":["text","image"],"output":["text"]}}
            }})),
            ("alpha", serde_json::json!({"id":"alpha","name":"Alpha AI","models":{
                "shared":{"id":"shared","type":"chat","reasoning":true,"limit":{"context":128000},"cost":{"input":0}},
                "cheap":{"id":"cheap","type":"chat","limit":{"context":8192},"cost":{"input":0.1}},
                "unknown":{"id":"unknown"}
            }})),
        ].into_iter().map(|(id, raw)| (Box::<str>::from(id), Arc::new(LazyProvider {
            id: id.into(), raw: Arc::from(raw.to_string()), parsed: OnceLock::new(),
        }))).collect();
        ModelCatalog {
            manifest: bundled_catalog().unwrap().manifest().clone(),
            providers,
        }
    }

    #[test]
    fn global_search_is_stable_provider_scoped_and_does_not_expand_lazy_caches() {
        let catalog = fixture();
        let mut query = CatalogSearch {
            limit: Some(2),
            ..Default::default()
        };
        let first = catalog.search(&query).unwrap();
        assert_eq!(first.total, 4);
        assert_eq!(
            first
                .models
                .iter()
                .map(|model| (model.provider_id.as_str(), model.model.id.as_str()))
                .collect::<Vec<_>>(),
            vec![("alpha", "cheap"), ("alpha", "shared")]
        );
        query.offset = usize::MAX;
        let second = catalog.search(&query).unwrap();
        assert_eq!(second.offset, 2);
        assert_eq!(
            second
                .models
                .iter()
                .map(|model| (model.provider_id.as_str(), model.model.id.as_str()))
                .collect::<Vec<_>>(),
            vec![("zeta", "shared"), ("alpha", "unknown")]
        );
        assert!(catalog
            .providers
            .values()
            .all(|provider| provider.parsed.get().is_none()));
        query.provider = "missing".into();
        assert_eq!(catalog.search(&query).unwrap().total, 0);
    }

    #[test]
    fn filters_and_prices_distinguish_unknown_from_free() {
        let catalog = fixture();
        let query = CatalogSearch {
            capability: "reasoning".into(),
            model_type: "chat".into(),
            input_modality: "image".into(),
            min_context: 150000,
            ..Default::default()
        };
        let result = catalog.search(&query).unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.models[0].provider_id, "zeta");
        assert!(result.types.contains("chat"));
        let query = CatalogSearch {
            query: "ZETA AI".into(),
            ..Default::default()
        };
        assert_eq!(catalog.search(&query).unwrap().total, 1);
        for (descending, first) in [(false, "alpha"), (true, "zeta")] {
            let result = catalog
                .search(&CatalogSearch {
                    sort: "input-price".into(),
                    descending,
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(result.models[0].provider_id, first);
            assert_eq!(result.models.last().unwrap().model.id, "unknown");
        }
    }

    #[test]
    fn search_rejects_unbounded_pages_unknown_filters_and_stale_snapshots() {
        for query in [
            CatalogSearch {
                limit: Some(0),
                ..Default::default()
            },
            CatalogSearch {
                limit: Some(101),
                ..Default::default()
            },
            CatalogSearch {
                sort: "random".into(),
                ..Default::default()
            },
            CatalogSearch {
                capability: "invented".into(),
                ..Default::default()
            },
            CatalogSearch {
                query: "x".repeat(257),
                ..Default::default()
            },
        ] {
            assert!(query.validate().is_err());
        }
        assert_eq!(
            fixture()
                .search(&CatalogSearch {
                    snapshot: Some("0".repeat(64)),
                    ..Default::default()
                })
                .unwrap_err(),
            "catalog snapshot changed"
        );
    }
}
