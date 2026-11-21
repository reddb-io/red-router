//! Final per-model thinking guards, ported from the legacy
//! `open-sse/services/claudeAdaptiveThinking.ts`, and the legacy
//! `normalizeAttemptBody` order that applies them with the model spec
//! normalization before a body leaves for the upstream.

use crate::model_specs::{
    is_adaptive_thinking_only, max_effort_when_thinking_disabled, normalize_thinking_for_model,
};
use serde_json::{Map, Value};

/// Legacy `normalizeClaudeAdaptiveThinking`: on an adaptive-only model a
/// manual `thinking.type:"enabled"` becomes `"adaptive"` and fixed budgets
/// are dropped; `disabled` and budget-free adaptive thinking stay. Returns
/// whether the body changed.
pub fn normalize_claude_adaptive_thinking(body: &mut Map<String, Value>, model: &str) -> bool {
    if !is_adaptive_thinking_only(model) {
        return false;
    }
    let Some(thinking) = body.get_mut("thinking").and_then(Value::as_object_mut) else {
        return false;
    };
    let manual = thinking.get("type").is_some_and(|kind| kind == "enabled");
    let budget = thinking.contains_key("budget_tokens") || thinking.contains_key("max_tokens");
    if !manual && !budget {
        return false;
    }
    if manual {
        thinking.insert("type".to_owned(), Value::String("adaptive".to_owned()));
    }
    thinking.remove("budget_tokens");
    thinking.remove("max_tokens");
    true
}

/// Legacy `normalizeClaudeDisabledThinkingEffort`: the direct Anthropic API
/// providers (`anthropic`, `claude`) accept disabled thinking on a model with
/// a disabled-effort ceiling only up to `high`, so `xhigh`/`max` are capped.
pub fn normalize_claude_disabled_thinking_effort(
    body: &mut Map<String, Value>,
    model: &str,
    provider: Option<&str>,
) -> bool {
    if !matches!(provider, Some("anthropic" | "claude")) {
        return false;
    }
    let Some(cap) = max_effort_when_thinking_disabled(model).filter(|cap| *cap == "high") else {
        return false;
    };
    let disabled = body
        .get("thinking")
        .and_then(Value::as_object)
        .and_then(|thinking| thinking.get("type"))
        .is_some_and(|kind| kind == "disabled");
    let Some(output_config) = body.get_mut("output_config").and_then(Value::as_object_mut) else {
        return false;
    };
    let effort = output_config
        .get("effort")
        .and_then(Value::as_str)
        .map(str::to_lowercase)
        .unwrap_or_default();
    if !disabled || (effort != "xhigh" && effort != "max") {
        return false;
    }
    output_config.insert("effort".to_owned(), Value::String(cap.to_owned()));
    true
}

/// The model-keyed guards of legacy `normalizeAttemptBody`, in its order:
/// `normalizeThinkingForModel`, `normalizeClaudeAdaptiveThinking` and
/// `normalizeClaudeDisabledThinkingEffort`, for the model actually called.
pub fn normalize_attempt_body(body: &mut Value, model: &str, provider: Option<&str>) {
    let Some(body) = body.as_object_mut() else {
        return;
    };
    normalize_thinking_for_model(body, model);
    normalize_claude_adaptive_thinking(body, model);
    normalize_claude_disabled_thinking_effort(body, model, provider);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn adaptive(body: Value, model: &str) -> (bool, Map<String, Value>) {
        let mut body = object(body);
        (normalize_claude_adaptive_thinking(&mut body, model), body)
    }

    // Ported from tests/unit/claude-adaptive-thinking-normalize.test.ts.
    #[test]
    fn manual_thinking_collapses_to_adaptive_on_adaptive_only_models() {
        for (thinking, model) in [
            (
                json!({"type":"enabled","budget_tokens":131072}),
                "claude-opus-4-8",
            ),
            (
                json!({"type":"enabled","budget_tokens":4096,"max_tokens":8000}),
                "claude-opus-4-7",
            ),
            (json!({"type":"enabled"}), "claude-fable-5"),
            (
                json!({"type":"enabled","budget_tokens":64000}),
                "claude-opus-5",
            ),
            (
                json!({"type":"adaptive","budget_tokens":5}),
                "claude-opus-4-8",
            ),
            (
                json!({"type":"enabled","budget_tokens":1000}),
                "anthropic.claude-opus-4-8",
            ),
        ] {
            let (changed, body) = adaptive(json!({"messages":[],"thinking":thinking}), model);
            assert!(changed, "{model}");
            assert_eq!(body["thinking"], json!({"type":"adaptive"}), "{model}");
        }
        let (changed, body) = adaptive(
            json!({"model":"claude-opus-4-8","messages":[{"role":"user","content":"hi"}],"output_config":{"effort":"high"},"thinking":{"type":"enabled","budget_tokens":32000}}),
            "claude-opus-4-8",
        );
        assert!(changed);
        assert_eq!(
            Value::Object(body),
            json!({"model":"claude-opus-4-8","messages":[{"role":"user","content":"hi"}],"output_config":{"effort":"high"},"thinking":{"type":"adaptive"}})
        );
    }

    #[test]
    fn other_bodies_and_models_are_left_alone() {
        for (body, model) in [
            (json!({"thinking":{"type":"adaptive"}}), "claude-opus-4-8"),
            (json!({"thinking":{"type":"disabled"}}), "claude-opus-4-8"),
            (
                json!({"thinking":{"type":"enabled","budget_tokens":96000}}),
                "claude-opus-4-6",
            ),
            (
                json!({"messages":[{"role":"user","content":"hi"}]}),
                "claude-opus-4-8",
            ),
            (json!({"thinking":{"type":"enabled"}}), ""),
        ] {
            let (changed, after) = adaptive(body.clone(), model);
            assert!(!changed, "{model} {body}");
            assert_eq!(Value::Object(after), body);
        }
        let mut not_object = json!(null);
        normalize_attempt_body(&mut not_object, "claude-opus-4-8", None);
        assert_eq!(not_object, Value::Null);
    }

    #[test]
    fn direct_anthropic_providers_cap_disabled_thinking_effort() {
        for provider in ["anthropic", "claude"] {
            for effort in ["xhigh", "max"] {
                let mut body = object(json!({
                    "model":"claude-opus-5",
                    "request_marker":"preserve-me",
                    "thinking":{"type":"disabled"},
                    "output_config":{"effort":effort,"format":"compact"}
                }));
                assert!(normalize_claude_disabled_thinking_effort(
                    &mut body,
                    "claude-opus-5",
                    Some(provider)
                ));
                assert_eq!(body["request_marker"], "preserve-me");
                assert_eq!(body["thinking"], json!({"type":"disabled"}));
                assert_eq!(
                    body["output_config"],
                    json!({"effort":"high","format":"compact"})
                );
            }
        }
        for provider in [Some("github"), Some("claude-web"), None] {
            let mut body =
                object(json!({"thinking":{"type":"disabled"},"output_config":{"effort":"max"}}));
            assert!(!normalize_claude_disabled_thinking_effort(
                &mut body,
                "claude-opus-5",
                provider
            ));
        }
        let mut body =
            object(json!({"thinking":{"type":"disabled"},"output_config":{"effort":"high"}}));
        assert!(!normalize_claude_disabled_thinking_effort(
            &mut body,
            "claude-opus-5",
            Some("anthropic")
        ));
    }

    // Ported from tests/unit/minimax-m3-adaptive-thinking-12132.test.ts.
    #[test]
    fn minimax_m3_collapses_manual_thinking() {
        assert!(is_adaptive_thinking_only("minimax-m3"));
        assert!(is_adaptive_thinking_only("MiniMax-M3"));
        let (changed, body) = adaptive(
            json!({"thinking":{"type":"enabled","budget_tokens":20000},"output_config":{"effort":"max"}}),
            "MiniMax-M3",
        );
        assert!(changed);
        assert_eq!(body["thinking"], json!({"type":"adaptive"}));
    }

    #[test]
    fn the_attempt_body_runs_the_guards_in_the_legacy_order() {
        // Fable 5 rejects disabled thinking and forced tool choices.
        let mut body =
            json!({"thinking":{"type":"disabled"},"tool_choice":"required","tools":[{"name":"x"}]});
        normalize_attempt_body(&mut body, "claude-fable-5", Some("claude"));
        assert_eq!(body.get("thinking"), None);
        assert_eq!(body["tools"], json!([{"name":"x"}]));
    }
}
