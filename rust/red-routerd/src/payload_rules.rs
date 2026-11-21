//! Operator payload rules, ported from the legacy
//! `open-sse/services/payloadRules.ts`.
//!
//! Rules match a model by glob (`wildcard_router::wildcard_match`) and,
//! optionally, a protocol, then mutate the upstream payload by dotted path:
//! `default` and `defaultRaw` set absent values (`defaultRaw` parses JSON
//! strings), `override` always sets, and `filter` removes. They run in that
//! order on the translated body, as in the legacy upstream body builder.
//!
//! One difference: rule parameters are applied in key order, where the legacy
//! code uses JSON insertion order; it only matters when two parameters of one
//! rule address overlapping paths.

use serde_json::{Map, Value};

use crate::wildcard_router::wildcard_match;

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct PayloadRuleModelSpec {
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) protocol: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct PayloadMutationRule {
    pub(crate) models: Vec<PayloadRuleModelSpec>,
    pub(crate) params: Map<String, Value>,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct PayloadFilterRule {
    pub(crate) models: Vec<PayloadRuleModelSpec>,
    pub(crate) params: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PayloadRulesConfig {
    pub(crate) default: Vec<PayloadMutationRule>,
    pub(crate) r#override: Vec<PayloadMutationRule>,
    pub(crate) filter: Vec<PayloadFilterRule>,
    pub(crate) default_raw: Vec<PayloadMutationRule>,
}

impl PayloadRulesConfig {
    pub(crate) fn is_empty(&self) -> bool {
        self.default.is_empty()
            && self.r#override.is_empty()
            && self.filter.is_empty()
            && self.default_raw.is_empty()
    }
}

/// What a rule did, for diagnostics: its kind and path.
pub(crate) type AppliedPayloadRule = (&'static str, String);

fn items(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn normalize_model_specs(value: Option<&Value>) -> Vec<PayloadRuleModelSpec> {
    items(value)
        .iter()
        .filter_map(|item| {
            let name = item.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() {
                return None;
            }
            let protocol = item
                .get("protocol")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|protocol| !protocol.is_empty());
            Some(PayloadRuleModelSpec {
                name: name.to_owned(),
                protocol: protocol.map(str::to_owned),
            })
        })
        .collect()
}

fn normalize_mutation_rules<'a>(
    values: impl Iterator<Item = &'a Value>,
) -> Vec<PayloadMutationRule> {
    values
        .filter_map(|item| {
            let models = normalize_model_specs(item.get("models"));
            let params = item.get("params").and_then(Value::as_object)?.clone();
            (!models.is_empty() && !params.is_empty())
                .then_some(PayloadMutationRule { models, params })
        })
        .collect()
}

fn normalize_filter_rules(value: Option<&Value>) -> Vec<PayloadFilterRule> {
    items(value)
        .iter()
        .filter_map(|item| {
            let models = normalize_model_specs(item.get("models"));
            let params: Vec<String> = items(item.get("params"))
                .iter()
                .filter_map(|path| path.as_str().map(str::trim))
                .filter(|path| !path.is_empty())
                .map(str::to_owned)
                .collect();
            (!models.is_empty() && !params.is_empty())
                .then_some(PayloadFilterRule { models, params })
        })
        .collect()
}

/// Legacy `normalizePayloadRulesConfig`: invalid entries are dropped, and the
/// historical `default-raw` key is merged after `defaultRaw`.
pub(crate) fn normalize_payload_rules_config(value: &Value) -> PayloadRulesConfig {
    PayloadRulesConfig {
        default: normalize_mutation_rules(items(value.get("default")).iter()),
        r#override: normalize_mutation_rules(items(value.get("override")).iter()),
        filter: normalize_filter_rules(value.get("filter")),
        default_raw: normalize_mutation_rules(
            items(value.get("defaultRaw"))
                .iter()
                .chain(items(value.get("default-raw"))),
        ),
    }
}

fn path_segments(path: &str) -> Vec<&str> {
    path.split('.')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn is_index_segment(segment: &str) -> bool {
    !segment.is_empty() && segment.bytes().all(|b| b.is_ascii_digit())
}

fn value_at_path<'a>(payload: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cursor = payload;
    for segment in path_segments(path) {
        cursor = match cursor {
            Value::Array(items) if is_index_segment(segment) => {
                items.get(segment.parse::<usize>().ok()?)?
            }
            Value::Object(object) => object.get(segment)?,
            _ => return None,
        };
    }
    Some(cursor)
}

/// The slot for `index` in `items`, padding with `null` like a sparse JS array.
fn array_slot(items: &mut Vec<Value>, index: usize) -> &mut Value {
    if items.len() <= index {
        items.resize(index + 1, Value::Null);
    }
    &mut items[index]
}

fn set_value_at_path(payload: &mut Value, path: &str, value: &Value) {
    let segments = path_segments(path);
    let Some((last, parents)) = segments.split_last() else {
        return;
    };
    let mut cursor = payload;
    for (position, segment) in parents.iter().enumerate() {
        let next_is_index = is_index_segment(segments[position + 1]);
        let container = || {
            if next_is_index {
                Value::Array(Vec::new())
            } else {
                Value::Object(Map::new())
            }
        };
        cursor = match cursor {
            Value::Array(items) => {
                let Ok(index) = segment.parse::<usize>() else {
                    return;
                };
                let slot = array_slot(items, index);
                if !(slot.is_object() || slot.is_array()) {
                    *slot = container();
                }
                slot
            }
            Value::Object(object) => {
                let slot = object.entry((*segment).to_owned()).or_insert(Value::Null);
                if !(slot.is_object() || slot.is_array()) || slot.is_array() != next_is_index {
                    *slot = container();
                }
                slot
            }
            _ => return,
        };
    }
    match cursor {
        Value::Array(items) => {
            if let Ok(index) = last.parse::<usize>() {
                *array_slot(items, index) = value.clone();
            }
        }
        Value::Object(object) => {
            object.insert((*last).to_owned(), value.clone());
        }
        _ => {}
    }
}

fn unset_value_at_path(payload: &mut Value, path: &str) -> bool {
    let segments = path_segments(path);
    let Some((last, parents)) = segments.split_last() else {
        return false;
    };
    let mut cursor = payload;
    for segment in parents {
        cursor = match cursor {
            Value::Array(items) if is_index_segment(segment) => {
                match segment
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| items.get_mut(index))
                {
                    Some(item) => item,
                    None => return false,
                }
            }
            Value::Object(object) => match object.get_mut(*segment) {
                Some(item) => item,
                None => return false,
            },
            _ => return false,
        };
    }
    match cursor {
        Value::Array(items) if is_index_segment(last) => match last.parse::<usize>() {
            Ok(index) if index < items.len() => {
                items.remove(index);
                true
            }
            _ => false,
        },
        Value::Object(object) => object.remove(*last).is_some(),
        _ => false,
    }
}

/// A rule writing a non-empty Gemini 3.x thinking level supersedes the
/// deprecated numeric `thinkingBudget`.
fn is_thinking_level_write(path: &str, value: &Value) -> bool {
    value.as_str().is_some_and(|level| !level.trim().is_empty())
        && path_segments(path)
            .iter()
            .any(|segment| matches!(*segment, "thinkingLevel" | "thinking_level"))
}

fn drop_deprecated_thinking_budget(payload: &mut Value) {
    for container in ["generationConfig", "generation_config"] {
        let Some(config) = payload.get_mut(container).and_then(Value::as_object_mut) else {
            continue;
        };
        let key = if config.contains_key("thinkingConfig") {
            "thinkingConfig"
        } else {
            "thinking_config"
        };
        if let Some(thinking) = config.get_mut(key).and_then(Value::as_object_mut) {
            thinking.remove("thinkingBudget");
        }
    }
}

fn parse_default_raw_value(value: &Value) -> Value {
    match value {
        Value::String(text) => serde_json::from_str(text).unwrap_or_else(|_| value.clone()),
        other => other.clone(),
    }
}

fn matches_protocol(spec: Option<&str>, protocols: &[String]) -> bool {
    spec.is_none_or(|spec| {
        let spec = spec.trim().to_lowercase();
        protocols
            .iter()
            .any(|protocol| protocol.trim().to_lowercase() == spec)
    })
}

fn matches_rule(model: &str, protocols: &[String], specs: &[PayloadRuleModelSpec]) -> bool {
    specs.iter().any(|spec| {
        matches_protocol(spec.protocol.as_deref(), protocols) && wildcard_match(model, &spec.name)
    })
}

/// Legacy `resolvePayloadRuleProtocols`.
pub(crate) fn resolve_payload_rule_protocols(
    provider: Option<&str>,
    target_format: Option<&str>,
) -> Vec<String> {
    let mut protocols: Vec<String> = Vec::new();
    let mut add = |value: &str| {
        if !value.is_empty() && !protocols.iter().any(|existing| existing == value) {
            protocols.push(value.to_owned());
        }
    };
    if let Some(provider) = provider {
        add(provider);
    }
    if let Some(target) = target_format {
        add(target);
        match target {
            "openai-responses" | "openai-response" => add("openai"),
            "antigravity" => add("gemini"),
            _ => {}
        }
    }
    protocols
}

/// Legacy `applyPayloadRules`, in place.
pub(crate) fn apply_payload_rules(
    payload: &mut Value,
    model: &str,
    protocols: &[String],
    rules: &PayloadRulesConfig,
) -> Vec<AppliedPayloadRule> {
    let mut applied = Vec::new();
    let mut set_absent =
        |payload: &mut Value, rules: &[PayloadMutationRule], kind: &'static str, raw: bool| {
            for rule in rules
                .iter()
                .filter(|rule| matches_rule(model, protocols, &rule.models))
            {
                for (path, value) in &rule.params {
                    if value_at_path(payload, path).is_some() {
                        continue;
                    }
                    let value = if raw {
                        parse_default_raw_value(value)
                    } else {
                        value.clone()
                    };
                    set_value_at_path(payload, path, &value);
                    applied.push((kind, path.clone()));
                    if is_thinking_level_write(path, &value) {
                        drop_deprecated_thinking_budget(payload);
                    }
                }
            }
        };
    set_absent(payload, &rules.default, "default", false);
    set_absent(payload, &rules.default_raw, "default-raw", true);
    for rule in rules
        .r#override
        .iter()
        .filter(|rule| matches_rule(model, protocols, &rule.models))
    {
        for (path, value) in &rule.params {
            set_value_at_path(payload, path, value);
            applied.push(("override", path.clone()));
            if is_thinking_level_write(path, value) {
                drop_deprecated_thinking_budget(payload);
            }
        }
    }
    for rule in rules
        .filter
        .iter()
        .filter(|rule| matches_rule(model, protocols, &rule.models))
    {
        for path in &rule.params {
            if unset_value_at_path(payload, path) {
                applied.push(("filter", path.clone()));
            }
        }
    }
    applied
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules(value: Value) -> PayloadRulesConfig {
        normalize_payload_rules_config(&value)
    }

    fn protocols(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn normalization_drops_invalid_entries_and_merges_default_raw_spellings() {
        let config = rules(json!({
            "default": [{"models":[{"name":" gpt-* ","protocol":" openai "}],"params":{"temperature":0.2}},
                        {"models":[],"params":{"x":1}},
                        {"models":[{"name":"m"}],"params":{}}],
            "filter": [{"models":[{"name":"m"}],"params":[" stream_options ", "", 3]}],
            "defaultRaw": [{"models":[{"name":"a"}],"params":{"x":"1"}}],
            "default-raw": [{"models":[{"name":"b"}],"params":{"y":"2"}}]
        }));
        assert_eq!(config.default.len(), 1);
        assert_eq!(
            config.default[0].models[0],
            PayloadRuleModelSpec {
                name: "gpt-*".into(),
                protocol: Some("openai".into())
            }
        );
        assert_eq!(config.filter[0].params, ["stream_options"]);
        assert_eq!(config.default_raw.len(), 2);
        assert!(rules(json!(null)).is_empty());
    }

    #[test]
    fn defaults_fill_absent_paths_and_overrides_always_win() {
        let config = rules(json!({
            "default": [{"models":[{"name":"gpt-*"}],"params":{"temperature":0.2,"reasoning.effort":"high"}}],
            "override": [{"models":[{"name":"gpt-*"}],"params":{"max_tokens":512}}]
        }));
        let mut payload = json!({"model":"gpt-5","temperature":0.9,"max_tokens":10});
        let applied = apply_payload_rules(&mut payload, "gpt-5", &protocols(&["openai"]), &config);
        assert_eq!(payload["temperature"], 0.9);
        assert_eq!(payload["reasoning"]["effort"], "high");
        assert_eq!(payload["max_tokens"], 512);
        assert_eq!(
            applied.iter().map(|rule| rule.0).collect::<Vec<_>>(),
            ["default", "override"]
        );
        let mut other = json!({"model":"claude"});
        assert!(
            apply_payload_rules(&mut other, "claude", &protocols(&["openai"]), &config).is_empty()
        );
    }

    #[test]
    fn null_counts_as_present_for_defaults() {
        let config =
            rules(json!({"default": [{"models":[{"name":"*"}],"params":{"temperature":0.2}}]}));
        let mut payload = json!({"temperature":null});
        apply_payload_rules(&mut payload, "m", &[], &config);
        assert_eq!(payload["temperature"], Value::Null);
    }

    #[test]
    fn default_raw_parses_json_strings() {
        let config = rules(
            json!({"defaultRaw": [{"models":[{"name":"*"}],"params":{"response_format":"{\"type\":\"json_object\"}","stop":"not json"}}]}),
        );
        let mut payload = json!({});
        apply_payload_rules(&mut payload, "m", &[], &config);
        assert_eq!(payload["response_format"], json!({"type":"json_object"}));
        assert_eq!(payload["stop"], "not json");
    }

    #[test]
    fn filters_remove_object_keys_and_array_items() {
        let config = rules(
            json!({"filter": [{"models":[{"name":"*"}],"params":["stream_options","messages.0","missing.path"]}]}),
        );
        let mut payload = json!({"stream_options":{"include_usage":true},"messages":[{"role":"system"},{"role":"user"}]});
        let applied = apply_payload_rules(&mut payload, "m", &[], &config);
        assert!(payload.get("stream_options").is_none());
        assert_eq!(payload["messages"], json!([{"role":"user"}]));
        assert_eq!(applied.len(), 2);
    }

    #[test]
    fn paths_create_containers_and_pad_arrays() {
        let config =
            rules(json!({"override": [{"models":[{"name":"*"}],"params":{"a.0.b":1,"c.2":"x"}}]}));
        let mut payload = json!({"c":"scalar"});
        apply_payload_rules(&mut payload, "m", &[], &config);
        assert_eq!(payload["a"], json!([{"b":1}]));
        assert_eq!(payload["c"], json!([null, null, "x"]));
    }

    #[test]
    fn protocol_specs_must_match_a_resolved_protocol() {
        let config = rules(
            json!({"override": [{"models":[{"name":"*","protocol":"Gemini"}],"params":{"x":1}}]}),
        );
        let mut payload = json!({});
        apply_payload_rules(
            &mut payload,
            "m",
            &resolve_payload_rule_protocols(Some("openai"), Some("openai")),
            &config,
        );
        assert!(payload.get("x").is_none());
        apply_payload_rules(
            &mut payload,
            "m",
            &resolve_payload_rule_protocols(Some("agy"), Some("antigravity")),
            &config,
        );
        assert_eq!(payload["x"], 1);
        assert_eq!(
            resolve_payload_rule_protocols(Some("openai"), Some("openai-responses")),
            ["openai", "openai-responses"]
        );
    }

    #[test]
    fn a_thinking_level_write_drops_the_deprecated_budget() {
        let config = rules(
            json!({"override": [{"models":[{"name":"*"}],"params":{"generationConfig.thinkingConfig.thinkingLevel":"high"}}]}),
        );
        let mut payload = json!({"generationConfig":{"thinkingConfig":{"thinkingBudget":1024}}});
        apply_payload_rules(&mut payload, "gemini-3", &[], &config);
        assert_eq!(
            payload["generationConfig"]["thinkingConfig"],
            json!({"thinkingLevel":"high"})
        );
        let empty = rules(
            json!({"override": [{"models":[{"name":"*"}],"params":{"generationConfig.thinkingConfig.thinkingLevel":""}}]}),
        );
        let mut kept = json!({"generationConfig":{"thinkingConfig":{"thinkingBudget":1024}}});
        apply_payload_rules(&mut kept, "gemini-3", &[], &empty);
        assert_eq!(
            kept["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            1024
        );
    }
}
