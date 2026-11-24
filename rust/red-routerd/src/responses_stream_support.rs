//! Small pure helpers of the Responses stream translation, ported from the
//! legacy `utils/toolCallArguments.ts`, `translator/helpers/responsesTerminalStatus.ts`
//! and `translator/response/responsesToolItem.ts`.

use serde_json::{json, Map, Value};

/// Legacy `appendToolCallArgumentDelta`: accumulate streamed tool-call
/// `arguments` without corrupting them. An identical repeat or a growing
/// superset is a snapshot and replaces the buffer; anything else is an
/// incremental delta and is appended verbatim, so repeated characters
/// (`ls -ll`) survive.
///
/// An already-parsed object or array is serialized into a fragment instead of
/// being dropped (#6459); its keys come out sorted, where the legacy
/// `JSON.stringify` keeps insertion order.
pub fn append_tool_call_argument_delta(
    current: Option<&Value>,
    incoming: Option<&Value>,
) -> String {
    let existing = current.and_then(Value::as_str).unwrap_or("");
    let next = match incoming {
        Some(Value::String(text)) => text.clone(),
        Some(value @ (Value::Object(_) | Value::Array(_))) => {
            serde_json::to_string(value).unwrap_or_default()
        }
        _ => String::new(),
    };
    if existing.is_empty() {
        return next;
    }
    if next.is_empty() || next == existing {
        return existing.to_owned();
    }
    if next.starts_with(existing) {
        return next;
    }
    format!("{existing}{next}")
}

/// The terminal event a Responses stream ends with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalEvent {
    Completed,
    Incomplete,
    Failed,
}

impl TerminalEvent {
    /// The SSE event type.
    pub fn event_type(self) -> &'static str {
        match self {
            Self::Completed => "response.completed",
            Self::Incomplete => "response.incomplete",
            Self::Failed => "response.failed",
        }
    }
}

/// Legacy `finalizeResponsesTerminalStatus`: a truncated (`length`) or
/// filtered (`content_filter`) generation is `incomplete`, not `completed`,
/// and an Anthropic `pause_turn` is incomplete with no reason. An upstream
/// error wins and leaves the response untouched.
pub fn finalize_terminal_status(
    response: &mut Map<String, Value>,
    finish_reason: Option<&str>,
    has_upstream_error: bool,
) -> TerminalEvent {
    if has_upstream_error {
        return TerminalEvent::Failed;
    }
    let details = match finish_reason {
        Some("pause_turn") => Value::Null,
        Some("length") => json!({"reason": "max_output_tokens"}),
        Some("content_filter") => json!({"reason": "content_filter"}),
        _ => return TerminalEvent::Completed,
    };
    response.insert("status".to_owned(), json!("incomplete"));
    response.insert("incomplete_details".to_owned(), details);
    TerminalEvent::Incomplete
}

/// Legacy `buildResponsesToolCallItem`: the in-progress output item opened for
/// a tool call; a custom tool carries `input`, a function `arguments`, and the
/// namespace the request-side identity ledger resolved, if any.
pub fn build_tool_call_item(
    call_id: &str,
    tool_name: &str,
    custom: bool,
    namespace: Option<&str>,
) -> Value {
    let mut item = Map::new();
    item.insert("id".to_owned(), json!(format!("fc_{call_id}")));
    item.insert(
        "type".to_owned(),
        json!(if custom {
            "custom_tool_call"
        } else {
            "function_call"
        }),
    );
    item.insert(
        if custom { "input" } else { "arguments" }.to_owned(),
        json!(""),
    );
    item.insert("call_id".to_owned(), json!(call_id));
    item.insert("name".to_owned(), json!(tool_name));
    item.insert("status".to_owned(), json!("in_progress"));
    if let Some(namespace) = namespace.filter(|namespace| !namespace.is_empty()) {
        item.insert("namespace".to_owned(), json!(namespace));
    }
    Value::Object(item)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Outputs the legacy helpers produced for the same inputs
    /// (`responses_stream_support_oracle.json`, generated with Node).
    #[test]
    fn helpers_match_the_legacy_implementation() {
        let oracle: Value =
            serde_json::from_str(include_str!("responses_stream_support_oracle.json")).unwrap();
        for case in oracle["append"].as_array().unwrap() {
            let side = |index: usize| match &case[index] {
                Value::String(text) if text == "__undefined" => None,
                other => Some(other),
            };
            assert_eq!(
                append_tool_call_argument_delta(side(0), side(1)),
                case[2].as_str().unwrap(),
                "{case}"
            );
        }
        for case in oracle["terminal"].as_array().unwrap() {
            let mut response = Map::new();
            response.insert("status".to_owned(), json!("completed"));
            let reason = case[0].as_str();
            let event = finalize_terminal_status(&mut response, reason, case[1].as_bool().unwrap());
            assert_eq!(event.event_type(), case[2]["event"], "{case}");
            assert_eq!(Value::Object(response), case[2]["response"], "{case}");
        }
        for case in oracle["item"].as_array().unwrap() {
            let item = build_tool_call_item(
                case[0].as_str().unwrap(),
                case[1].as_str().unwrap(),
                case[2].as_bool().unwrap(),
                case[3].as_str(),
            );
            assert_eq!(item, case[4], "{case}");
        }
    }
}
