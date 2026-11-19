//! Reasoning-replay detection from the legacy `requiresReasoningReplay`
//! (`open-sse/services/reasoningCache.ts`) and `hasThinkingConfig`
//! (`open-sse/services/provider.ts`).
//!
//! Replay providers (DeepSeek V4 thinking, Kimi K2, MiMo, ...) reject a
//! conversation whose tool-call turns lost the client's `reasoning_content`,
//! so the OpenAI-format filter keeps it for them. The model registry's
//! `interleavedField` signal is not ported yet; this is the legacy fallback
//! (provider list and model patterns).
//!
//! The module also holds `normalizeThinkingConfig` and the replay pass over
//! assistant turns (`translateRequest`, `replayOpenAIReasoningMessage`) as
//! it runs on a reasoning-cache miss. The response-side cache is not ported,
//! so every lookup misses; `injectEmptyReasoningContentForToolCalls` is left
//! out because on a miss its empty field is always removed or replaced later.

use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

const REPLAY_PROVIDERS: [&str; 12] = [
    "deepseek",
    "opencode-go",
    "siliconflow",
    "nebius",
    "deepinfra",
    "sambanova",
    "fireworks",
    "together",
    "kimi-coding",
    "kimi-coding-apikey",
    "xiaomi-mimo",
    "command-code",
];

struct Patterns {
    k3: Regex,
    native_k27: Regex,
    legacy_reasoner: Regex,
    deepseek_v4: Regex,
    models: Vec<Regex>,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let compile = |pattern: &str| Regex::new(pattern).expect("static pattern");
        Patterns {
            k3: compile(r"(?i)(?:^|/)(?:kimi-)?k3(?:$|-)"),
            native_k27: compile(r"(?i)(?:^|/)kimi-k2\.7-code(?:$|-)"),
            legacy_reasoner: compile(r"(?i)deepseek-reasoner|deepseek-r1"),
            deepseek_v4: compile(r"(?i)deepseek[-/]v4(?:[-.]\d+)?[-.](flash|pro)"),
            models: [
                r"(?i)deepseek-chat",
                r"(?i)deepseek[-/]v4(?:[-.]\d+)?[-.](flash|pro)(-free)?",
                r"(?i)zen/deepseek-v4",
                r"(?i)kimi[-/]k\d",
                r"(?i)qwq",
                r"(?i)qwen.*think",
                r"(?i)glm.*think",
                r"(?i)^mimo[-.]?v\d",
            ]
            .into_iter()
            .map(compile)
            .collect(),
        }
    })
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// Legacy `isLastMessageFromUser` (`messages`, else Gemini `contents`).
fn last_message_from_user(body: &Value) -> bool {
    let messages = Some(body.get("messages"))
        .filter(|messages| truthy(*messages))
        .flatten()
        .or_else(|| body.get("contents"));
    match messages.and_then(Value::as_array) {
        Some(messages) if !messages.is_empty() => {
            messages
                .last()
                .and_then(|last| last.get("role"))
                .and_then(Value::as_str)
                == Some("user")
        }
        _ => true,
    }
}

/// Legacy `normalizeThinkingConfig`: a Claude-style `thinking` block is
/// dropped unless the last message is from the user; OpenAI
/// `reasoning_effort` stays a request-level option.
pub(crate) fn normalize_thinking_config(body: &mut Value) {
    if !last_message_from_user(body) {
        if let Some(object) = body.as_object_mut() {
            object.remove("thinking");
        }
    }
}

/// Legacy `hasThinkingConfig`, read after `normalizeThinkingConfig` dropped a
/// Claude-style `thinking` block whose last message is not from the user.
pub(crate) fn has_thinking_config(body: &Value) -> bool {
    if truthy(body.get("reasoning_effort")) {
        return true;
    }
    body.pointer("/thinking/type").and_then(Value::as_str) == Some("enabled")
        && last_message_from_user(body)
}

/// Legacy `requiresReasoningReplay` without the registry `interleavedField`.
pub(crate) fn requires_reasoning_replay(provider: &str, model: &str, thinking: bool) -> bool {
    replay_contract(provider, model, thinking, true)
}

/// `requiresReasoningReplay` with `allowLegacyFallback: false`: only the
/// explicit model contracts (Kimi K3, native Kimi K2.7 Code, DeepSeek V4
/// thinking).
pub(crate) fn requires_explicit_reasoning_replay(
    provider: &str,
    model: &str,
    thinking: bool,
) -> bool {
    replay_contract(provider, model, thinking, false)
}

fn replay_contract(provider: &str, model: &str, thinking: bool, legacy_fallback: bool) -> bool {
    let provider = provider.trim().to_lowercase();
    let model = model.trim();
    let patterns = patterns();
    if patterns.k3.is_match(model) {
        return true;
    }
    if matches!(provider.as_str(), "moonshot" | "kimi") && patterns.native_k27.is_match(model) {
        return true;
    }
    // The legacy DeepSeek reasoner family has the inverse contract.
    if patterns.legacy_reasoner.is_match(model) {
        return false;
    }
    if thinking && patterns.deepseek_v4.is_match(model) {
        return true;
    }
    legacy_fallback
        && (REPLAY_PROVIDERS.contains(&provider.as_str())
            || patterns
                .models
                .iter()
                .any(|pattern| pattern.is_match(model)))
}

use crate::reasoning_placeholder::{
    is_internal_reasoning_placeholder as is_placeholder, model_family,
    requires_reasoning_content_presence,
    NON_ANTHROPIC_THINKING_PLACEHOLDER as REASONING_PLACEHOLDER,
};

/// Legacy `isReasoningOnlyReplayTarget`: DeepSeek V4 and MiMo also need
/// reasoning back on plain assistant turns.
fn reasoning_only_replay_target(provider: &str, model: &str) -> bool {
    let provider = provider.trim().to_lowercase();
    let model = model.trim().to_lowercase();
    provider == "deepseek"
        || model_family(&model, "deepseek")
        || provider == "xiaomi-mimo"
        || model_family(&model, "mimo")
        || requires_explicit_reasoning_replay(&provider, &model, false)
}

fn has_reasoning_content(message: &Map<String, Value>) -> bool {
    matches!(message.get("reasoning_content"), Some(Value::String(text)) if !text.is_empty())
}

fn drop_empty_or_placeholder(message: &mut Map<String, Value>) {
    let reasoning = message.get("reasoning_content");
    if reasoning.and_then(Value::as_str) == Some("") || is_placeholder(reasoning) {
        message.remove("reasoning_content");
    }
}

/// The legacy reasoning-replay pass over OpenAI-format assistant turns of a
/// replay provider (`translateRequest` and `replayOpenAIReasoningMessage`),
/// on a reasoning-cache miss: the router does not cache upstream reasoning
/// yet. A turn's `reasoning` text stands in for missing `reasoning_content`;
/// otherwise presence-enforcing upstreams get the placeholder and the rest
/// get no field.
pub(crate) fn replay_reasoning(body: &mut Value, provider: &str, model: &str, explicit: bool) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let reasoning_only_target = reasoning_only_replay_target(provider, model);
    let presence = requires_reasoning_content_presence(provider, model);
    for message in messages.iter_mut().filter_map(Value::as_object_mut) {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        // Moonshot partial turns are output prefixes, not completed turns.
        if message.get("partial") == Some(&Value::Bool(true)) {
            if message.get("reasoning_content").and_then(Value::as_str) == Some("") {
                message.remove("reasoning_content");
            }
            continue;
        }
        let has_tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|calls| !calls.is_empty());
        let has_tool_use_blocks = !has_tool_calls
            && message
                .get("content")
                .and_then(Value::as_array)
                .is_some_and(|blocks| {
                    blocks
                        .iter()
                        .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
                });
        // Claude-format turns keep thinking blocks; the OpenAI-format filter
        // has already removed their `tool_use` blocks.
        if has_tool_use_blocks {
            continue;
        }
        let reasoning_only = |message: &Map<String, Value>| {
            !has_tool_calls && reasoning_only_target && !has_reasoning_content(message)
        };
        if !has_tool_calls && !reasoning_only(message) {
            drop_empty_or_placeholder(message);
            continue;
        }
        if !has_reasoning_content(message) {
            if let Some(Value::String(reasoning)) = message.get("reasoning") {
                if !reasoning.trim().is_empty() {
                    let reasoning = reasoning.clone();
                    message.insert("reasoning_content".to_owned(), Value::String(reasoning));
                }
            }
        }
        if !has_tool_calls && !reasoning_only(message) {
            drop_empty_or_placeholder(message);
            continue;
        }
        if has_reasoning_content(message) {
            if !is_placeholder(message.get("reasoning_content")) {
                continue;
            }
            message.remove("reasoning_content");
        }
        if explicit && message.get("reasoning_content").and_then(Value::as_str) == Some("") {
            message.remove("reasoning_content");
        }
        if !truthy(message.get("reasoning_content")) {
            if presence {
                message.insert(
                    "reasoning_content".to_owned(),
                    Value::String(REASONING_PLACEHOLDER.to_owned()),
                );
            } else if !explicit {
                message.remove("reasoning_content");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replay_follows_the_legacy_provider_and_model_rules() {
        assert!(requires_reasoning_replay(" DeepSeek ", "anything", false));
        assert!(requires_reasoning_replay(
            "router",
            "moonshot/kimi-k2-turbo",
            false
        ));
        assert!(requires_reasoning_replay("router", "k3", false));
        assert!(requires_reasoning_replay("kimi", "kimi-k2.7-code", false));
        assert!(requires_reasoning_replay("router", "Qwen3-Thinking", false));
        assert!(requires_reasoning_replay("router", "mimo-v2-flash", false));
        assert!(requires_reasoning_replay(
            "router",
            "deepseek-v4-pro",
            false
        ));
        // The legacy reasoner family never replays, whatever the provider.
        assert!(!requires_reasoning_replay(
            "deepseek",
            "deepseek-reasoner",
            true
        ));
        assert!(!requires_reasoning_replay("openai", "gpt-5", true));
        assert!(!requires_reasoning_replay("router", "kimi-latest", false));
    }

    #[test]
    fn thinking_config_needs_effort_or_a_trailing_user_turn() {
        assert!(has_thinking_config(&json!({"reasoning_effort":"high"})));
        assert!(!has_thinking_config(&json!({"reasoning_effort":""})));
        let enabled = |role: &str| json!({"thinking":{"type":"enabled"},"messages":[{"role":role,"content":"x"}]});
        assert!(has_thinking_config(&enabled("user")));
        assert!(!has_thinking_config(&enabled("assistant")));
        assert!(has_thinking_config(&json!({"thinking":{"type":"enabled"}})));
        assert!(!has_thinking_config(
            &json!({"thinking":{"type":"disabled"}})
        ));
    }

    #[test]
    fn explicit_replay_covers_only_the_model_contracts() {
        assert!(requires_explicit_reasoning_replay(
            "router", "kimi-k3", false
        ));
        assert!(requires_explicit_reasoning_replay(
            "deepseek",
            "deepseek-v4-flash",
            true
        ));
        assert!(!requires_explicit_reasoning_replay(
            "deepseek",
            "deepseek-v4-flash",
            false
        ));
        assert!(!requires_explicit_reasoning_replay(
            "deepseek",
            "deepseek-chat",
            true
        ));
    }

    #[test]
    fn thinking_blocks_are_dropped_unless_the_user_spoke_last() {
        let mut body = json!({"thinking":{"type":"enabled"},"messages":[
            {"role":"user","content":"x"},{"role":"assistant","content":"prefill"}
        ]});
        normalize_thinking_config(&mut body);
        assert!(body.get("thinking").is_none());
        let mut kept = json!({"thinking":{"type":"enabled"},"reasoning_effort":"low","messages":[
            {"role":"user","content":"x"}
        ]});
        let before = kept.clone();
        normalize_thinking_config(&mut kept);
        assert_eq!(kept, before);
    }

    #[test]
    fn replay_turns_fall_back_to_reasoning_text_or_the_placeholder() {
        let turns = json!({"messages":[
            {"role":"user","content":"q"},
            {"role":"assistant","tool_calls":[{"id":"a"}],"reasoning":"from reasoning"},
            {"role":"assistant","tool_calls":[{"id":"b"}],"reasoning_content":""},
            {"role":"assistant","tool_calls":[{"id":"c"}],"reasoning_content":REASONING_PLACEHOLDER},
            {"role":"assistant","tool_calls":[{"id":"d"}],"reasoning_content":"kept"},
            {"role":"assistant","content":"plain","reasoning_content":""},
            {"role":"assistant","content":"","partial":true,"reasoning_content":""}
        ]});
        // MiMo enforces presence and replays plain turns too.
        let mut mimo = turns.clone();
        replay_reasoning(&mut mimo, "xiaomi-mimo", "mimo-v2-flash", false);
        let replayed = &mimo["messages"];
        assert_eq!(replayed[1]["reasoning_content"], "from reasoning");
        assert_eq!(replayed[2]["reasoning_content"], REASONING_PLACEHOLDER);
        assert_eq!(replayed[3]["reasoning_content"], REASONING_PLACEHOLDER);
        assert_eq!(replayed[4]["reasoning_content"], "kept");
        assert_eq!(replayed[5]["reasoning_content"], REASONING_PLACEHOLDER);
        assert!(replayed[6].get("reasoning_content").is_none());
        // Kimi Coding gets no field on a miss, and plain turns drop it.
        let mut kimi = turns.clone();
        replay_reasoning(&mut kimi, "kimi-coding", "kimi-k2-thinking", false);
        let replayed = &kimi["messages"];
        assert_eq!(replayed[1]["reasoning_content"], "from reasoning");
        assert!(replayed[2].get("reasoning_content").is_none());
        assert!(replayed[3].get("reasoning_content").is_none());
        assert_eq!(replayed[4]["reasoning_content"], "kept");
        assert!(replayed[5].get("reasoning_content").is_none());
    }
}
