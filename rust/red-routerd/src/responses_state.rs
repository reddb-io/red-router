//! Responses API `previous_response_id` handling, ported from the legacy
//! `open-sse/utils/responsesStatePolicy.ts` and the continuation branch of
//! `src/sse/handlers/chat.ts`.
//!
//! The legacy router rebuilds a continued conversation from its detailed
//! call-log artifacts (`responsesContinuationStore.ts`), which only exist
//! while `call_log_pipeline_enabled` is on. Rust keeps no such artifacts, so
//! it answers exactly as the legacy router does with that pipeline off: a
//! continuation it cannot resolve gets OpenAI's own
//! `previous_response_not_found`, and the client resends the full history.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Legacy `RESPONSES_PREVIOUS_RESPONSE_ID_MODES`; `auto` by default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviousResponseIdMode {
    #[default]
    Auto,
    Strip,
    Preserve,
}

impl PreviousResponseIdMode {
    /// Legacy `normalizeResponsesPreviousResponseIdMode`: anything else is auto.
    pub(crate) fn normalize(value: &Value) -> Self {
        match value.as_str() {
            Some("strip") => Self::Strip,
            Some("preserve") => Self::Preserve,
            _ => Self::Auto,
        }
    }

    /// The legacy chat handler's continuation branch: outside `preserve`, a
    /// Responses request naming a previous response needs its stored state,
    /// which Rust does not keep.
    pub(crate) fn rejects_continuation(self, responses_request: bool, body: &Value) -> bool {
        self != Self::Preserve
            && responses_request
            && body
                .get("previous_response_id")
                .is_some_and(Value::is_string)
    }

    /// Legacy `shouldStripPreviousResponseId`: `strip` always, `preserve`
    /// never, `auto` for Responses traffic (the caller keeps it when the
    /// connection stores Responses state, legacy `openaiStoreEnabled`).
    pub(crate) fn strips(self, responses_source: bool, responses_target: bool) -> bool {
        match self {
            Self::Strip => true,
            Self::Preserve => false,
            Self::Auto => responses_source || responses_target,
        }
    }

    /// Legacy `applyResponsesPreviousResponseIdPolicy`: whether the field is
    /// removed from this attempt's body. Under auto the only continuity
    /// field stays when the input would ship empty.
    pub(crate) fn apply(
        self,
        body: &mut Value,
        responses_source: bool,
        responses_target: bool,
        store_enabled: bool,
    ) -> bool {
        let Some(record) = body.as_object_mut() else {
            return false;
        };
        if !record.contains_key("previous_response_id")
            || !self.strips(responses_source, responses_target)
            || (self == Self::Auto && store_enabled)
        {
            return false;
        }
        let empty_input = match record.get("input") {
            None => true,
            Some(Value::Array(items)) => items.is_empty(),
            Some(_) => false,
        };
        if self == Self::Auto && empty_input {
            return false;
        }
        record.remove("previous_response_id");
        true
    }
}

/// OpenAI's own `previous_response_not_found` body.
pub(crate) fn not_found_body() -> Value {
    serde_json::json!({
        "error": {
            "message": "Previous response not found.",
            "type": "invalid_request_error",
            "code": "previous_response_not_found",
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Ported from tests/unit/responses-state-policy.test.ts.
    #[test]
    fn the_previous_response_id_policy_follows_the_mode() {
        use PreviousResponseIdMode::{Auto, Preserve, Strip};
        assert_eq!(PreviousResponseIdMode::normalize(&Value::Null), Auto);
        assert_eq!(PreviousResponseIdMode::normalize(&json!("invalid")), Auto);
        assert_eq!(PreviousResponseIdMode::normalize(&json!("strip")), Strip);
        assert_eq!(
            PreviousResponseIdMode::normalize(&json!("preserve")),
            Preserve
        );

        let input = json!([{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}]);
        let mut body = json!({"model": "gpt-5.5", "previous_response_id": "resp_prev_123", "input": input.clone()});
        assert!(Auto.apply(&mut body, true, true, false));
        assert!(body.get("previous_response_id").is_none());

        // Auto keeps the only continuity field when input would be empty.
        let mut body =
            json!({"model": "gpt-5.5", "previous_response_id": "resp_prev_123", "input": []});
        assert!(!Auto.apply(&mut body, true, true, false));
        assert_eq!(body["previous_response_id"], "resp_prev_123");
        assert!(Strip.apply(&mut body, true, true, false));
        assert!(body.get("previous_response_id").is_none());

        // Auto keeps it for a connection that stores Responses state.
        let mut body = json!({"previous_response_id": "resp_prev_123", "input": input});
        assert!(!Auto.apply(&mut body, true, true, true));
        assert!(Strip.apply(&mut body, true, true, true));
        assert!(Strip.strips(false, false));
        assert!(!Preserve.strips(true, true));
        let mut body =
            json!({"model": "gpt-4o-mini", "previous_response_id": "client-extra-field"});
        assert!(!Auto.apply(&mut body, false, false, false));
        assert_eq!(body["previous_response_id"], "client-extra-field");
    }

    // Ported from tests/unit/chat-previous-response-id-preserve-mode.test.ts.
    #[test]
    fn an_unresolvable_continuation_is_refused_outside_preserve() {
        use PreviousResponseIdMode::{Auto, Preserve, Strip};
        let body = json!({"model": "gpt-5.5", "previous_response_id": "resp_unknown", "input": []});
        assert!(Auto.rejects_continuation(true, &body));
        assert!(Strip.rejects_continuation(true, &body));
        assert!(!Preserve.rejects_continuation(true, &body));
        assert!(!Auto.rejects_continuation(false, &body));
        assert!(!Auto.rejects_continuation(true, &json!({"previous_response_id": null})));
        assert_eq!(
            not_found_body()["error"]["code"],
            "previous_response_not_found"
        );
    }
}
