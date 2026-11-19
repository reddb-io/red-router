//! Global gateway settings stored as JSON values (`global_settings_storage`).
//! Only the keys listed here are accepted; each has a typed value and a
//! default. Each control plane keeps a validated snapshot for the request
//! path, as the legacy router reads its cached settings.
//!
//! - `custom_system_prompt`: the legacy `customSystemPromptEnabled` and
//!   `customSystemPrompt`, injected into chat-like requests
//!   (`injectCustomSystemPrompt`, open-sse/services/systemPrompt.ts).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) const CUSTOM_SYSTEM_PROMPT: &str = "custom_system_prompt";
const MAX_PROMPT_LEN: usize = 100_000;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomSystemPrompt {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub prompt: String,
}

impl CustomSystemPrompt {
    fn validate(&self) -> Result<(), &'static str> {
        if self.prompt.len() > MAX_PROMPT_LEN || self.prompt.contains('\0') {
            return Err("invalid custom system prompt");
        }
        Ok(())
    }
}

/// The validated settings a control plane serves from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Snapshot {
    custom_system_prompt: CustomSystemPrompt,
}

impl Snapshot {
    /// The prompt to inject, when enabled and non-empty.
    pub(crate) fn custom_system_prompt(&self) -> Option<&str> {
        let prompt = &self.custom_system_prompt;
        (prompt.enabled && !prompt.prompt.is_empty()).then_some(prompt.prompt.as_str())
    }
}

/// Validate one setting value, returning its normalized JSON.
pub(crate) fn validate(key: &str, value: Value) -> Result<Value, &'static str> {
    match key {
        CUSTOM_SYSTEM_PROMPT => {
            let prompt: CustomSystemPrompt =
                serde_json::from_value(value).map_err(|_| "invalid custom system prompt")?;
            prompt.validate()?;
            serde_json::to_value(prompt).map_err(|_| "invalid custom system prompt")
        }
        _ => Err("unknown global setting"),
    }
}

/// Validate the stored settings into a snapshot. Unknown stored keys fail
/// closed.
pub(crate) fn snapshot(stored: &BTreeMap<String, Value>) -> Result<Snapshot, &'static str> {
    let mut snapshot = Snapshot::default();
    for (key, value) in stored {
        let value = validate(key, value.clone())?;
        if key == CUSTOM_SYSTEM_PROMPT {
            snapshot.custom_system_prompt =
                serde_json::from_value(value).map_err(|_| "invalid custom system prompt")?;
        }
    }
    Ok(snapshot)
}

/// JavaScript string concatenation of a message's prior content.
fn js_text(value: &Value) -> Option<String> {
    match value {
        Value::Null | Value::Bool(false) => None,
        Value::String(text) if text.is_empty() => None,
        Value::String(text) => Some(text.clone()),
        Value::Number(number) if number.as_f64() == Some(0.0) => None,
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(true) => Some("true".to_owned()),
        Value::Object(_) => Some("[object Object]".to_owned()),
        Value::Array(_) => None,
    }
}

/// Legacy `injectCustomSystemPrompt`: append to the first system/developer
/// message (a text part for array content), else prepend a system message,
/// except for Anthropic-shaped bodies, which take it in the top-level
/// `system` field.
pub(crate) fn inject_custom_system_prompt(body: &mut Value, prompt: &str) {
    let Some(request) = body.as_object_mut() else {
        return;
    };
    if prompt.is_empty() || request.contains_key("_skipSystemPrompt") {
        return;
    }
    let has_system = request.contains_key("system");
    if let Some(Value::Array(messages)) = request.get_mut("messages") {
        let index = messages.iter().position(|message| {
            matches!(
                message.get("role").and_then(Value::as_str),
                Some("system" | "developer")
            )
        });
        match index {
            Some(index) => {
                if let Some(message) = messages[index].as_object_mut() {
                    match message.get_mut("content") {
                        Some(Value::Array(parts)) => {
                            parts.push(serde_json::json!({"type":"text","text":prompt}));
                        }
                        content => {
                            let prior = content.as_deref().and_then(js_text);
                            message.insert(
                                "content".to_owned(),
                                Value::String(match prior {
                                    Some(prior) => format!("{prior}\n\n{prompt}"),
                                    None => prompt.to_owned(),
                                }),
                            );
                        }
                    }
                }
            }
            None if !has_system => {
                messages.insert(0, serde_json::json!({"role":"system","content":prompt}));
            }
            None => {}
        }
    }
    if let Some(system) = request.get_mut("system") {
        match system {
            Value::String(text) if !text.is_empty() => {
                *system = Value::String(format!("{text}\n\n{prompt}"));
            }
            Value::Array(parts) => {
                parts.push(serde_json::json!({"type":"text","text":prompt}));
            }
            // A malformed or empty `system` must not swallow the prompt.
            _ => *system = Value::String(prompt.to_owned()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_prompt_is_injected_like_the_legacy_helper() {
        let mut body = json!({"messages":[{"role":"user","content":"hi"}]});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(body["messages"][0], json!({"role":"system","content":"P"}));

        let mut body =
            json!({"messages":[{"role":"user","content":"hi"},{"role":"developer","content":"D"}]});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(body["messages"][1]["content"], "D\n\nP");
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);

        let mut body =
            json!({"messages":[{"role":"system","content":[{"type":"text","text":"S"}]}]});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(
            body["messages"][0]["content"][1],
            json!({"type":"text","text":"P"})
        );

        // Anthropic-shaped bodies use the top-level system field only.
        let mut body = json!({"system":"S","messages":[{"role":"user","content":"hi"}]});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(body["system"], "S\n\nP");
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        let mut body = json!({"system":null,"messages":[]});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(body["system"], "P");
        let mut body = json!({"system":[{"type":"text","text":"S"}]});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(body["system"][1]["text"], "P");

        // A Responses body without messages is left alone.
        let mut body = json!({"input":"hi"});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(body, json!({"input":"hi"}));
    }

    #[test]
    fn only_known_valid_settings_are_accepted() {
        assert_eq!(
            validate(CUSTOM_SYSTEM_PROMPT, json!({"enabled":true,"prompt":"P"})),
            Ok(json!({"enabled":true,"prompt":"P"}))
        );
        assert_eq!(
            validate(CUSTOM_SYSTEM_PROMPT, json!({})),
            Ok(json!({"enabled":false,"prompt":""}))
        );
        assert!(validate(CUSTOM_SYSTEM_PROMPT, json!({"other":1})).is_err());
        assert!(validate("unknown", json!(1)).is_err());
    }
}
