//! Message role normalization for provider compatibility, ported from the
//! legacy `open-sse/services/roleNormalizer.ts`.
//!
//! 1. `model` becomes `assistant`.
//! 2. `developer` becomes `system` unless the upstream understands it: for an
//!    OpenAI-format target the model's `preserveOpenAIDeveloperRole` flag
//!    decides, defaulting to the OpenAI-family provider allowlist (#2281).
//! 3. For providers and models that reject `system`, system and developer
//!    content moves into the first user message.

use serde_json::Value;
use std::sync::OnceLock;

/// Providers that reject the `system` role (DuckDuckGo duck.ai, id and alias).
const PROVIDERS_WITHOUT_SYSTEM_ROLE: [&str; 2] = ["duckduckgo-web", "ddgw"];

/// Providers known to accept the OpenAI `developer` role.
const PROVIDERS_PRESERVING_DEVELOPER_ROLE: [&str; 4] =
    ["openai", "azure-openai", "azure", "github"];

/// Models that reject the `system` role regardless of provider (prefixes).
const MODELS_WITHOUT_SYSTEM_ROLE: [&str; 1] = ["ernie-"];

fn default_preserve_developer_for_provider(provider: &str) -> bool {
    let id = provider.trim().to_lowercase();
    !id.is_empty()
        && (PROVIDERS_PRESERVING_DEVELOPER_ROLE.contains(&id.as_str()) || id.contains("openai"))
}

/// GLM rejects `system` except generation 5.1 and newer (#5610); the version
/// comes from `glm-<major>.<minor>` or the Fireworks `glm-5p1` form.
fn is_glm_without_system_role(model_lower: &str) -> bool {
    static VERSION: OnceLock<regex::Regex> = OnceLock::new();
    if !model_lower.starts_with("glm") {
        return false;
    }
    let version = VERSION.get_or_init(|| {
        regex::Regex::new(r"glm-?([0-9]+)(?:[.p]([0-9]+))?").expect("valid GLM version pattern")
    });
    if let Some(captures) = version.captures(model_lower) {
        let number = |index: usize| {
            captures.get(index).map_or(0.0, |value| {
                value.as_str().parse::<f64>().unwrap_or(f64::INFINITY)
            })
        };
        let (major, minor) = (number(1), number(2));
        if major > 5.0 || (major == 5.0 && minor >= 1.0) {
            return false;
        }
    }
    true
}

/// ZenMux exposes Z.AI GLM under vendor-prefixed ids such as `z-ai/glm-5.2`.
fn is_provider_scoped_model_without_system_role(provider_lower: &str, model_lower: &str) -> bool {
    static ZENMUX_GLM: OnceLock<regex::Regex> = OnceLock::new();
    provider_lower == "zenmux"
        && ZENMUX_GLM
            .get_or_init(|| regex::Regex::new(r"(?:^|/)glm(?:-|$)").expect("valid ZenMux pattern"))
            .is_match(model_lower)
}

fn supports_system_role(provider: &str, model: &str) -> bool {
    let provider_lower = provider.trim().to_lowercase();
    if PROVIDERS_WITHOUT_SYSTEM_ROLE.contains(&provider_lower.as_str()) {
        return false;
    }
    let model_lower = model.to_lowercase();
    !is_provider_scoped_model_without_system_role(&provider_lower, &model_lower)
        && !is_glm_without_system_role(&model_lower)
        && !MODELS_WITHOUT_SYSTEM_ROLE
            .iter()
            .any(|prefix| model_lower.starts_with(prefix))
}

fn role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

fn set_role(message: &mut Value, role: &str) {
    if let Some(object) = message.as_object_mut() {
        object.insert("role".to_owned(), Value::String(role.to_owned()));
    }
}

/// Text of a string content or of the `text` parts of a content array.
fn extract_text_from_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .map(|part| part.get("text").and_then(Value::as_str).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Legacy `normalizeModelRole`: `model` (any case) becomes `assistant`.
pub(crate) fn normalize_model_role(messages: &mut [Value]) {
    for message in messages {
        if role(message).is_some_and(|role| role.eq_ignore_ascii_case("model")) {
            set_role(message, "assistant");
        }
    }
}

/// Legacy `normalizeDeveloperRole`.
pub(crate) fn normalize_developer_role(
    messages: &mut [Value],
    target_is_openai: bool,
    preserve_developer_role: Option<bool>,
    provider: &str,
) {
    if target_is_openai
        && preserve_developer_role
            .unwrap_or_else(|| default_preserve_developer_for_provider(provider))
    {
        return;
    }
    for message in messages {
        if role(message).is_some_and(|role| role.eq_ignore_ascii_case("developer")) {
            set_role(message, "system");
        }
    }
}

/// Legacy `normalizeSystemRole`: for upstreams without a system role, fold
/// system and developer content into the first user message.
pub(crate) fn normalize_system_role(messages: &mut Vec<Value>, provider: &str, model: &str) {
    if messages.is_empty() || supports_system_role(provider, model) {
        return;
    }
    let is_system = |message: &Value| matches!(role(message), Some("system" | "developer"));
    if !messages.iter().any(is_system) {
        return;
    }
    let system_content = messages
        .iter()
        .filter(|&message| is_system(message))
        .map(|message| extract_text_from_content(message.get("content")))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    messages.retain(|message| !is_system(message));
    if system_content.is_empty() {
        return;
    }
    match messages
        .iter_mut()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
    {
        Some(user) => {
            let user_content = extract_text_from_content(user.get("content"));
            if let Some(object) = user.as_object_mut() {
                object.insert(
                    "content".to_owned(),
                    Value::String(format!(
                        "[System Instructions]\n{system_content}\n\n[User Message]\n{user_content}"
                    )),
                );
            }
        }
        None => messages.insert(
            0,
            serde_json::json!({"role":"user","content":format!("[System Instructions]\n{system_content}")}),
        ),
    }
}

/// Legacy `normalizeRoles` over a request body's `messages`.
pub(crate) fn normalize_roles(
    body: &mut Value,
    provider: &str,
    model: &str,
    target_is_openai: bool,
    preserve_developer_role: Option<bool>,
) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    normalize_model_role(messages);
    normalize_developer_role(
        messages,
        target_is_openai,
        preserve_developer_role,
        provider,
    );
    normalize_system_role(messages, provider, model);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn developer(target_is_openai: bool, preserve: Option<bool>, provider: &str) -> Value {
        let mut messages = vec![json!({"role":"developer","content":"internal policy"})];
        normalize_developer_role(&mut messages, target_is_openai, preserve, provider);
        messages[0]["role"].clone()
    }

    fn system(provider: &str, model: &str, messages: Value) -> Value {
        let mut messages = messages.as_array().unwrap().clone();
        normalize_system_role(&mut messages, provider, model);
        Value::Array(messages)
    }

    // tests/unit/role-normalizer.test.ts
    #[test]
    fn developer_role_is_kept_only_for_openai_family_targets_or_when_forced() {
        assert_eq!(developer(true, None, "openai"), "developer");
        let mut mixed_case = vec![json!({"role":"DeVeloper","content":"internal policy"})];
        normalize_developer_role(&mut mixed_case, true, Some(false), "");
        assert_eq!(
            mixed_case[0],
            json!({"role":"system","content":"internal policy"})
        );
        for provider in [
            "deepseek",
            "minimax",
            "xiaomi-mimo",
            "glm",
            "fireworks",
            "together",
        ] {
            assert_eq!(developer(true, None, provider), "system", "{provider}");
        }
        for provider in [
            "openai",
            "azure-openai",
            "azure",
            "github",
            "azure-openai-gov",
        ] {
            assert_eq!(developer(true, None, provider), "developer", "{provider}");
        }
        assert_eq!(developer(true, Some(true), "deepseek"), "developer");
        assert_eq!(developer(false, Some(true), "openai"), "system");
    }

    #[test]
    fn model_role_becomes_assistant_case_insensitively() {
        let mut messages = vec![json!({"role":"MoDeL","content":"generated text"})];
        normalize_model_role(&mut messages);
        assert_eq!(
            messages[0],
            json!({"role":"assistant","content":"generated text"})
        );
    }

    #[test]
    fn supported_pairs_keep_their_system_messages() {
        let messages = json!([{"role":"system","content":"follow policy"},{"role":"user","content":"say hello"}]);
        assert_eq!(system("openai", "gpt-5", messages.clone()), messages);
        for model in [
            "glm-5.1",
            "glm-5.2",
            "glm-5.1-precision",
            "glm-5.2-high",
            "glm-5.2-max",
            "glm-5p1",
        ] {
            let messages =
                json!([{"role":"system","content":"be helpful"},{"role":"user","content":"hello"}]);
            assert_eq!(system("glm", model, messages.clone()), messages, "{model}");
        }
    }

    #[test]
    fn system_and_developer_content_folds_into_the_first_user_message() {
        let result = system(
            "openai",
            "glm-4.5",
            json!([
                {"role":"system","content":[{"type":"text","text":"follow policy"}]},
                {"role":"developer","content":[{"type":"text","text":"prefer concise answers"}]},
                {"role":"user","content":[{"type":"text","text":"say hello"}]},
                {"role":"assistant","content":"prior answer"}
            ]),
        );
        assert_eq!(
            result,
            json!([
                {"role":"user","content":"[System Instructions]\nfollow policy\n\nprefer concise answers\n\n[User Message]\nsay hello"},
                {"role":"assistant","content":"prior answer"}
            ])
        );
        for model in [
            "glm",
            "glm-4.7",
            "glm-5",
            "glm-5-turbo",
            "glm-5.0",
            "glm-5.0-turbo",
        ] {
            assert_eq!(
                system(
                    "openai",
                    model,
                    json!([{"role":"system","content":"policy"},{"role":"user","content":"ok"}])
                ),
                json!([{"role":"user","content":"[System Instructions]\npolicy\n\n[User Message]\nok"}]),
                "{model}"
            );
        }
    }

    #[test]
    fn a_user_message_is_inserted_when_none_exists_and_empty_system_text_is_dropped() {
        let result = system(
            "openai",
            "ernie-4.0",
            json!([
                {"role":"system","content":[{"type":"image_url","image_url":{"url":"ignored"}}]},
                {"role":"developer","content":"plain developer text"},
                {"role":"assistant","content":"ready"}
            ]),
        );
        assert_eq!(
            result,
            json!([
                {"role":"user","content":"[System Instructions]\nplain developer text"},
                {"role":"assistant","content":"ready"}
            ])
        );
    }

    #[test]
    fn zenmux_vendor_prefixed_glm_models_fold_like_glm() {
        let assistant = json!({"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{}"}}]});
        let tool = json!({"role":"tool","tool_call_id":"call_1","content":"ok"});
        let result = system(
            "zenmux",
            "z-ai/glm-5.2",
            json!([{"role":"system","content":"[Context compressed: earlier messages removed]"}, assistant, tool]),
        );
        assert_eq!(
            result,
            json!([{"role":"user","content":"[System Instructions]\n[Context compressed: earlier messages removed]"}, assistant, tool])
        );
    }

    #[test]
    fn normalize_roles_composes_model_developer_and_system_steps() {
        let mut body = json!({"messages":[
            {"role":"model","content":"first answer"},
            {"role":"developer","content":"internal policy"},
            {"role":"user","content":"help me"},
            {"role":"","content":"empty role should survive"}
        ]});
        normalize_roles(&mut body, "openai", "glm-4.7", true, Some(false));
        assert_eq!(
            body["messages"],
            json!([
                {"role":"assistant","content":"first answer"},
                {"role":"user","content":"[System Instructions]\ninternal policy\n\n[User Message]\nhelp me"},
                {"role":"","content":"empty role should survive"}
            ])
        );
    }

    #[test]
    fn duck_ai_providers_fold_system_and_developer_messages() {
        for provider in ["duckduckgo-web", "ddgw"] {
            assert_eq!(
                system(
                    provider,
                    "gpt-5.4-nano",
                    json!([{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"Reply with OK"}])
                ),
                json!([{"role":"user","content":"[System Instructions]\nYou are a helpful assistant.\n\n[User Message]\nReply with OK"}]),
                "{provider}"
            );
        }
        for model in [
            "gpt-5.4-mini",
            "gpt-5.4-nano",
            "claude-haiku-4-5",
            "mistral-small-2603",
        ] {
            let mut body = json!({"messages":[{"role":"developer","content":"policy"},{"role":"user","content":"hello"}]});
            normalize_roles(&mut body, "ddgw", model, true, None);
            assert_eq!(
                body["messages"],
                json!([{"role":"user","content":"[System Instructions]\npolicy\n\n[User Message]\nhello"}]),
                "{model}"
            );
        }
    }

    #[test]
    fn bodies_without_messages_are_unchanged() {
        let mut body = json!({"input":"x"});
        normalize_roles(&mut body, "openai", "gpt-5", true, None);
        assert_eq!(body, json!({"input":"x"}));
    }
}
