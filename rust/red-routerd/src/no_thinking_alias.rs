//! The no-thinking gateway alias, ported from the legacy
//! `open-sse/utils/noThinkingAlias.ts` (request side).
//!
//! `no-think/<provider>/<model>` selects the real `<provider>/<model>` with
//! reasoning suppressed, so a client that always attaches a thinking block can
//! still turn it off by model choice. Messages requests get
//! `thinking: {type: "disabled"}`; Chat Completions get
//! `reasoning_effort: "none"` (a thinks-by-default model otherwise keeps its
//! provider default); Responses get `reasoning: {effort: "none"}`, the shape
//! the legacy translator promotes `reasoning_effort` into for that protocol.

use serde_json::Value;

/// Legacy `NO_THINKING_PREFIX`.
pub(crate) const NO_THINKING_PREFIX: &str = "no-think/";

/// The request shape the suppression is expressed in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReasoningShape {
    Messages,
    ChatCompletions,
    Responses,
}

/// Legacy `applyNoThinkingAlias`: rewrite a no-thinking alias to the real
/// model and suppress reasoning in place. Returns whether it applied.
pub(crate) fn apply_no_thinking_alias(body: &mut Value, shape: ReasoningShape) -> bool {
    let Some(request) = body.as_object_mut() else {
        return false;
    };
    let Some(real) = request
        .get("model")
        .and_then(Value::as_str)
        .and_then(|model| model.strip_prefix(NO_THINKING_PREFIX))
        .filter(|real| !real.is_empty())
        .map(str::to_owned)
    else {
        return false;
    };
    request.insert("model".to_owned(), Value::String(real));
    request.remove("reasoning");
    match shape {
        ReasoningShape::Messages => {
            request.insert(
                "thinking".to_owned(),
                serde_json::json!({"type": "disabled"}),
            );
            request.remove("reasoning_effort");
        }
        ReasoningShape::ChatCompletions => {
            request.insert(
                "reasoning_effort".to_owned(),
                Value::String("none".to_owned()),
            );
        }
        ReasoningShape::Responses => {
            request.remove("reasoning_effort");
            request.insert(
                "reasoning".to_owned(),
                serde_json::json!({"effort": "none"}),
            );
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_alias_resolves_to_the_real_model_with_reasoning_suppressed() {
        let mut body = json!({"model":"no-think/claude/claude-opus-4-7","thinking":{"type":"enabled"},"reasoning_effort":"high"});
        assert!(apply_no_thinking_alias(&mut body, ReasoningShape::Messages));
        assert_eq!(
            body,
            json!({"model":"claude/claude-opus-4-7","thinking":{"type":"disabled"}})
        );

        let mut body = json!({"model":"no-think/openai/o4","reasoning":{"effort":"high"}});
        assert!(apply_no_thinking_alias(
            &mut body,
            ReasoningShape::ChatCompletions
        ));
        assert_eq!(body, json!({"model":"openai/o4","reasoning_effort":"none"}));

        let mut body = json!({"model":"no-think/openai/o4","reasoning":{"effort":"high"},"reasoning_effort":"high"});
        assert!(apply_no_thinking_alias(
            &mut body,
            ReasoningShape::Responses
        ));
        assert_eq!(
            body,
            json!({"model":"openai/o4","reasoning":{"effort":"none"}})
        );

        // Other models, a bare prefix and non-objects are left alone.
        for model in ["claude/claude-opus-4-7", "no-think/"] {
            let mut body = json!({"model":model,"thinking":{"type":"enabled"}});
            let before = body.clone();
            assert!(!apply_no_thinking_alias(
                &mut body,
                ReasoningShape::Messages
            ));
            assert_eq!(body, before);
        }
        assert!(!apply_no_thinking_alias(
            &mut json!([]),
            ReasoningShape::Messages
        ));
    }
}
