//! Reasoning-replay detection from the legacy `requiresReasoningReplay`
//! (`open-sse/services/reasoningCache.ts`) and `hasThinkingConfig`
//! (`open-sse/services/provider.ts`).
//!
//! Replay providers (DeepSeek V4 thinking, Kimi K2, MiMo, ...) reject a
//! conversation whose tool-call turns lost the client's `reasoning_content`,
//! so the OpenAI-format filter keeps it for them. The model registry's
//! `interleavedField` signal is not ported yet; this is the legacy fallback
//! (provider list and model patterns).

use regex::Regex;
use serde_json::Value;
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

/// Legacy `hasThinkingConfig`, read after `normalizeThinkingConfig` dropped a
/// Claude-style `thinking` block whose last message is not from the user.
pub(crate) fn has_thinking_config(body: &Value) -> bool {
    if truthy(body.get("reasoning_effort")) {
        return true;
    }
    if body.pointer("/thinking/type").and_then(Value::as_str) != Some("enabled") {
        return false;
    }
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

/// Legacy `requiresReasoningReplay` without the registry `interleavedField`.
pub(crate) fn requires_reasoning_replay(provider: &str, model: &str, thinking: bool) -> bool {
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
    REPLAY_PROVIDERS.contains(&provider.as_str())
        || patterns
            .models
            .iter()
            .any(|pattern| pattern.is_match(model))
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
}
