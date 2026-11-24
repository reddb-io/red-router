//! Centralized model specifications, ported from the legacy
//! `src/shared/constants/modelSpecs.ts`: output-token caps, context windows,
//! thinking budgets and the request normalizations that keep a substituted
//! model from rejecting a client's choice.
//!
//! `model_specs.json` is the legacy `MODEL_SPECS` table and its two
//! unexported authority tables, generated from the TypeScript in insertion
//! order (prefix matching depends on it).

use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::LazyLock;

/// Legacy `ModelSpec`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub max_output_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub default_thinking_budget: Option<u64>,
    pub thinking_budget_cap: Option<u64>,
    pub thinking_overhead: Option<u64>,
    pub adaptive_max_tokens: Option<u64>,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub supports_thinking: Option<bool>,
    pub supports_tools: Option<bool>,
    pub supports_vision: Option<bool>,
    pub supports_audio: Option<bool>,
    pub supports_video: Option<bool>,
    pub rejects_thinking_disabled: Option<bool>,
    pub adaptive_thinking_only: Option<bool>,
    pub rejects_forced_tool_choice: Option<bool>,
    pub max_effort_when_thinking_disabled: Option<String>,
    pub no_thinking_alias: Option<bool>,
    pub default_reasoning_effort: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Table {
    specs: Vec<(String, ModelSpec)>,
    authoritative_ids: Vec<String>,
    provider_windows: Vec<(String, u64)>,
}

/// Legacy `getModelSpecIndex`, built once over the table.
struct Index {
    specs: Vec<(String, ModelSpec)>,
    by_id: HashMap<String, usize>,
    exact_ci: HashMap<String, usize>,
    alias_ci: HashMap<String, usize>,
    alias_exact: HashMap<String, usize>,
    prefix_candidates: Vec<(String, usize)>,
    authoritative_ids: Vec<String>,
    provider_windows: HashMap<String, u64>,
}

const DEFAULT_KEY: &str = "__default__";

static INDEX: LazyLock<Index> = LazyLock::new(|| {
    let table: Table =
        serde_json::from_str(include_str!("model_specs.json")).expect("bundled model specs");
    let mut index = Index {
        by_id: HashMap::new(),
        exact_ci: HashMap::new(),
        alias_ci: HashMap::new(),
        alias_exact: HashMap::new(),
        prefix_candidates: Vec::new(),
        authoritative_ids: table.authoritative_ids,
        provider_windows: table
            .provider_windows
            .into_iter()
            .map(|(key, window)| (key.to_lowercase(), window))
            .collect(),
        specs: Vec::new(),
    };
    for (position, (canonical, spec)) in table.specs.iter().enumerate() {
        index.by_id.entry(canonical.clone()).or_insert(position);
        let lower = canonical.to_lowercase();
        index.exact_ci.entry(lower.clone()).or_insert(position);
        for alias in &spec.aliases {
            index
                .alias_ci
                .entry(alias.to_lowercase())
                .or_insert(position);
            index.alias_exact.entry(alias.clone()).or_insert(position);
        }
        if canonical != DEFAULT_KEY {
            index.prefix_candidates.push((lower, position));
        }
    }
    index.specs = table.specs;
    index
});

fn canonical_at(position: usize) -> &'static str {
    &INDEX.specs[position].0
}

/// Legacy `findModelSpecIdByExactOrAlias`: case-insensitive exact or alias,
/// never `__default__`, no prefix phase.
pub fn find_model_spec_id_by_exact_or_alias(model_id: &str) -> Option<&'static str> {
    let lower = model_id.to_lowercase();
    [INDEX.exact_ci.get(&lower), INDEX.alias_ci.get(&lower)]
        .into_iter()
        .flatten()
        .map(|position| canonical_at(*position))
        .find(|canonical| *canonical != DEFAULT_KEY)
}

/// Legacy `getCanonicalModelSpecId`: exact key, then case-insensitive exact,
/// alias, and the first canonical id the model starts with.
pub fn canonical_model_spec_id(model_id: &str) -> Option<&'static str> {
    if let Some(position) = INDEX.by_id.get(model_id) {
        return Some(canonical_at(*position));
    }
    let lower = model_id.to_lowercase();
    if let Some(position) = INDEX
        .exact_ci
        .get(&lower)
        .or_else(|| INDEX.alias_ci.get(&lower))
    {
        return Some(canonical_at(*position));
    }
    INDEX
        .prefix_candidates
        .iter()
        .find(|(prefix, _)| lower.starts_with(prefix.as_str()))
        .map(|(_, position)| canonical_at(*position))
}

/// Legacy `getModelSpec`.
pub fn model_spec(model_id: &str) -> Option<&'static ModelSpec> {
    let canonical = canonical_model_spec_id(model_id)?;
    INDEX
        .by_id
        .get(canonical)
        .map(|position| &INDEX.specs[*position].1)
}

/// Legacy `getAuthoritativeContextWindow`: the context window of a model
/// whose bare id is authoritative regardless of what discovery reported.
pub fn authoritative_context_window(model_id: &str) -> Option<u64> {
    if model_id.is_empty() {
        return None;
    }
    let normalized = model_id.to_lowercase();
    let canonical = INDEX
        .authoritative_ids
        .iter()
        .find(|canonical| canonical.to_lowercase() == normalized)?;
    INDEX
        .by_id
        .get(canonical)
        .and_then(|position| INDEX.specs[*position].1.context_window)
}

/// Legacy `getAuthoritativeProviderContextWindow`.
pub fn authoritative_provider_context_window(provider: &str, model_id: &str) -> Option<u64> {
    INDEX
        .provider_windows
        .get(&format!("{provider}/{model_id}").to_lowercase())
        .copied()
}

/// JavaScript `String(value || "")`.
fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => String::new(),
        Some(other) => other.to_string(),
    }
}

/// Legacy `normalizeForcedToolChoiceForModel`: a forced tool choice dropped
/// for a model that rejects one, tools kept.
pub fn normalize_forced_tool_choice_for_model(body: &mut Map<String, Value>, model_id: &str) {
    if model_spec(model_id).and_then(|spec| spec.rejects_forced_tool_choice) != Some(true) {
        return;
    }
    let forced = match body.get("tool_choice") {
        Some(Value::String(choice)) => choice == "required" || choice == "any",
        Some(Value::Object(choice)) => matches!(
            js_string_or_empty(choice.get("type"))
                .to_lowercase()
                .as_str(),
            "any" | "tool" | "function"
        ),
        _ => false,
    };
    if forced {
        body.remove("tool_choice");
    }
}

/// Legacy `normalizeThinkingForModel`: `thinking:{type:"disabled"}` dropped
/// for a model that rejects it, then the forced tool choice normalization.
pub fn normalize_thinking_for_model(body: &mut Map<String, Value>, model_id: &str) {
    let disabled = body
        .get("thinking")
        .and_then(|thinking| thinking.get("type"))
        .is_some_and(|kind| kind == "disabled");
    if disabled
        && model_spec(model_id).and_then(|spec| spec.rejects_thinking_disabled) == Some(true)
    {
        body.remove("thinking");
    }
    normalize_forced_tool_choice_for_model(body, model_id);
}

/// Legacy `capMaxOutputTokens`: the requested value capped by the model's
/// limit, the limit when nothing was requested.
pub fn cap_max_output_tokens(model_id: &str, requested: Option<f64>) -> Option<f64> {
    let requested = requested.filter(|value| value.is_finite());
    match model_spec(model_id).and_then(|spec| spec.max_output_tokens) {
        None => requested,
        Some(cap) => Some(requested.map_or(cap as f64, |value| value.min(cap as f64))),
    }
}

/// Legacy `getDefaultThinkingBudget`.
pub fn default_thinking_budget(model_id: &str) -> u64 {
    model_spec(model_id)
        .and_then(|spec| spec.default_thinking_budget)
        .unwrap_or(0)
}

/// Legacy `isAdaptiveThinkingOnly`.
pub fn is_adaptive_thinking_only(model_id: &str) -> bool {
    !model_id.is_empty()
        && model_spec(model_id).and_then(|spec| spec.adaptive_thinking_only) == Some(true)
}

/// Legacy `getMaxEffortWhenThinkingDisabled`.
pub fn max_effort_when_thinking_disabled(model_id: &str) -> Option<&'static str> {
    if model_id.is_empty() {
        return None;
    }
    model_spec(model_id).and_then(|spec| spec.max_effort_when_thinking_disabled.as_deref())
}

/// Legacy `capThinkingBudget`.
pub fn cap_thinking_budget(model_id: &str, budget: f64) -> f64 {
    model_spec(model_id)
        .and_then(|spec| spec.thinking_budget_cap)
        .map_or(budget, |cap| budget.min(cap as f64))
}

/// Legacy `resolveModelAlias`: a case-sensitive exact alias to its canonical
/// id, anything else unchanged.
pub fn resolve_model_alias(model_id: &str) -> &str {
    INDEX
        .alias_exact
        .get(model_id)
        .map_or(model_id, |position| canonical_at(*position))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn number(value: &Value) -> Option<f64> {
        value.as_f64()
    }

    /// Lookups the legacy TypeScript answered for every canonical id, alias,
    /// case variant, dated suffix and a few misses (`model_specs_oracle.json`).
    #[test]
    fn lookups_match_the_legacy_implementation() {
        let oracle: Value = serde_json::from_str(include_str!("model_specs_oracle.json")).unwrap();
        for case in oracle["lookups"].as_array().unwrap() {
            let id = case[0].as_str().unwrap();
            assert_eq!(
                canonical_model_spec_id(id),
                case[1].as_str(),
                "canonical {id:?}"
            );
            assert_eq!(
                find_model_spec_id_by_exact_or_alias(id),
                case[2].as_str(),
                "exact {id:?}"
            );
            assert_eq!(
                resolve_model_alias(id),
                case[3].as_str().unwrap(),
                "alias {id:?}"
            );
            assert_eq!(
                authoritative_context_window(id),
                case[4].as_u64(),
                "window {id:?}"
            );
            assert_eq!(
                cap_max_output_tokens(id, Some(1_000_000.0)),
                number(&case[5]),
                "cap {id:?}"
            );
            assert_eq!(
                cap_max_output_tokens(id, None),
                number(&case[6]),
                "limit {id:?}"
            );
            assert_eq!(
                default_thinking_budget(id),
                case[7].as_u64().unwrap(),
                "budget {id:?}"
            );
            assert_eq!(
                is_adaptive_thinking_only(id),
                case[8].as_bool().unwrap(),
                "adaptive {id:?}"
            );
            assert_eq!(
                max_effort_when_thinking_disabled(id),
                case[9].as_str(),
                "effort {id:?}"
            );
            assert_eq!(
                cap_thinking_budget(id, 1_000_000.0),
                number(&case[10]).unwrap(),
                "thinking cap {id:?}"
            );
        }
        for case in oracle["providerLookups"].as_array().unwrap() {
            assert_eq!(
                authoritative_provider_context_window(
                    case[0].as_str().unwrap(),
                    case[1].as_str().unwrap()
                ),
                case[2].as_u64(),
                "{case}"
            );
        }
        for case in oracle["normalized"].as_array().unwrap() {
            let mut body = case[1].as_object().unwrap().clone();
            normalize_thinking_for_model(&mut body, case[0].as_str().unwrap());
            assert_eq!(Value::Object(body), case[2], "{case}");
        }
    }

    // Ported from tests/unit/model-spec-lookup-index-8697.test.ts and
    // resolve-model-alias-index-8697.test.ts.
    #[test]
    fn lookups_are_indexed_and_keep_their_case_rules() {
        let canonical = canonical_model_spec_id("GPT-5.6").unwrap();
        assert_eq!(model_spec("GPT-5.6"), model_spec(canonical));
        assert_eq!(
            canonical_model_spec_id("definitely-not-a-real-model-xyz-123"),
            None
        );
        assert_eq!(resolve_model_alias("openai/gpt-5.6"), "gpt-5.6");
        assert_eq!(resolve_model_alias("OpenAI/GPT-5.6"), "OpenAI/GPT-5.6");
        assert_eq!(
            resolve_model_alias("definitely-not-a-real-alias-xyz"),
            "definitely-not-a-real-alias-xyz"
        );
    }

    // Ported from tests/unit/combo-thinking-disabled-fable5-3554.test.ts.
    #[test]
    fn disabled_thinking_is_dropped_only_for_models_that_reject_it() {
        assert_eq!(
            model_spec("claude-fable-5")
                .unwrap()
                .rejects_thinking_disabled,
            Some(true)
        );
        for accepting in ["claude-opus-4-8", "claude-sonnet-4-6"] {
            assert_ne!(
                model_spec(accepting).and_then(|s| s.rejects_thinking_disabled),
                Some(true)
            );
            let mut body = json!({"model":accepting,"thinking":{"type":"disabled"}})
                .as_object()
                .unwrap()
                .clone();
            normalize_thinking_for_model(&mut body, accepting);
            assert_eq!(body["thinking"], json!({"type":"disabled"}));
        }
        let mut body =
            json!({"model":"claude-opus-4-8","thinking":{"type":"disabled"},"max_tokens":64000})
                .as_object()
                .unwrap()
                .clone();
        normalize_thinking_for_model(&mut body, "claude-fable-5");
        assert_eq!(
            Value::Object(body),
            json!({"model":"claude-opus-4-8","max_tokens":64000})
        );
        for thinking in [
            json!({"type":"enabled","budget_tokens":4000}),
            json!({"type":"adaptive"}),
        ] {
            let mut body = json!({"thinking":thinking.clone()})
                .as_object()
                .unwrap()
                .clone();
            normalize_thinking_for_model(&mut body, "claude-fable-5");
            assert_eq!(body["thinking"], thinking);
        }
        let mut body = json!({"model":"claude-fable-5","messages":[]})
            .as_object()
            .unwrap()
            .clone();
        normalize_thinking_for_model(&mut body, "claude-fable-5");
        assert_eq!(
            Value::Object(body),
            json!({"model":"claude-fable-5","messages":[]})
        );
        let mut body = json!({"thinking":{"type":"disabled"}})
            .as_object()
            .unwrap()
            .clone();
        normalize_thinking_for_model(&mut body, "some-unknown-model-xyz");
        assert_eq!(body["thinking"], json!({"type":"disabled"}));
    }
}
