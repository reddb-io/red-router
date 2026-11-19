//! The internal reasoning-replay placeholder, ported from the legacy
//! `open-sse/utils/reasoningPlaceholder.ts`.
//!
//! When an upstream requires non-empty reasoning on a replayed turn but the
//! original summary is unavailable, the router sends this sentinel. It is
//! request scaffolding, never user-visible reasoning.

use serde_json::Value;

/// Legacy `NON_ANTHROPIC_THINKING_PLACEHOLDER`.
pub(crate) const NON_ANTHROPIC_THINKING_PLACEHOLDER: &str = "(prior reasoning summary unavailable)";

/// Legacy `isInternalReasoningPlaceholder`.
pub(crate) fn is_internal_reasoning_placeholder(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| text.trim() == NON_ANTHROPIC_THINKING_PLACEHOLDER)
}

/// Legacy `stripInternalReasoningPlaceholder`: remove every occurrence of the
/// sentinel a model echoed into visible content. Only a value that was the
/// sentinel plus whitespace collapses to empty; streamed deltas keep their
/// meaningful surrounding spaces.
// The response translators that call it are not ported yet.
#[allow(dead_code)]
pub(crate) fn strip_internal_reasoning_placeholder(value: &str) -> String {
    if !value.contains(NON_ANTHROPIC_THINKING_PLACEHOLDER) {
        return value.to_owned();
    }
    let stripped = value.replace(NON_ANTHROPIC_THINKING_PLACEHOLDER, "");
    if stripped.trim().is_empty() {
        String::new()
    } else {
        stripped
    }
}

/// `true` when `model` starts with `name` or has a `/name` segment start.
pub(crate) fn model_family(model: &str, name: &str) -> bool {
    model.starts_with(name) || model.contains(&format!("/{name}"))
}

/// Legacy `requiresReasoningContentPresence`: upstreams that reject an absent
/// `reasoning_content` on a replay turn (Xiaomi MiMo, the opencode
/// gateways), so the placeholder must survive a cache miss.
pub(crate) fn requires_reasoning_content_presence(provider: &str, model: &str) -> bool {
    let provider = provider.trim().to_lowercase();
    let model = model.trim().to_lowercase();
    provider == "xiaomi-mimo"
        || model_family(&model, "mimo")
        || matches!(
            provider.as_str(),
            "opencode" | "opencode-go" | "opencode-zen"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_placeholder_is_recognized_and_stripped_like_the_legacy_helper() {
        assert!(is_internal_reasoning_placeholder(Some(&json!(
            "  (prior reasoning summary unavailable) "
        ))));
        assert!(!is_internal_reasoning_placeholder(Some(&json!("real"))));
        assert!(!is_internal_reasoning_placeholder(None));
        assert_eq!(
            strip_internal_reasoning_placeholder("(prior reasoning summary unavailable)  "),
            ""
        );
        assert_eq!(
            strip_internal_reasoning_placeholder(
                "Hello (prior reasoning summary unavailable)world "
            ),
            "Hello world "
        );
        assert_eq!(strip_internal_reasoning_placeholder(" keep "), " keep ");
    }

    #[test]
    fn presence_is_required_for_mimo_and_the_opencode_gateways() {
        assert!(requires_reasoning_content_presence(" Xiaomi-MiMo ", "x"));
        assert!(requires_reasoning_content_presence(
            "router",
            "vendor/MiMo-v2"
        ));
        assert!(requires_reasoning_content_presence(
            "opencode-go",
            "deepseek"
        ));
        assert!(!requires_reasoning_content_presence(
            "deepseek",
            "deepseek-v4"
        ));
    }
}
