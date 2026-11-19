//! Nine-character tool call IDs for upstreams that require them (Mistral),
//! the `use9CharId` path of the legacy `ensureToolCallIds`
//! (`open-sse/translator/helpers/toolCallHelper.ts`), applied when a model's
//! `normalizeToolCallId` compatibility flag is on.
//!
//! Each assistant `tool_calls[].id` becomes a 9-character `[A-Za-z0-9]` ID,
//! and the `tool` messages that follow, up to the next assistant message,
//! take the new IDs in order. The legacy code draws the IDs at random; here
//! they are derived from the original ID, which upstreams cannot tell apart
//! and which keeps a conversation's history byte-stable across turns.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const ALPHANUMERIC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/// A 9-character ID for `original`, unique within `used`.
fn nine_char_id(original: &str, position: (usize, usize), used: &mut HashSet<String>) -> String {
    let mut attempt = 0u32;
    loop {
        let mut digest = Sha256::new();
        digest.update(original.as_bytes());
        digest.update(position.0.to_le_bytes());
        digest.update(position.1.to_le_bytes());
        digest.update(attempt.to_le_bytes());
        let id: String = digest
            .finalize()
            .iter()
            .take(9)
            .map(|byte| char::from(ALPHANUMERIC[usize::from(*byte) % ALPHANUMERIC.len()]))
            .collect();
        if used.insert(id.clone()) {
            return id;
        }
        attempt += 1;
    }
}

/// Rewrite an OpenAI Chat Completions body's tool call IDs to 9 characters.
pub(crate) fn normalize_tool_call_ids(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for index in 0..messages.len() {
        let is_assistant = messages[index].get("role").and_then(Value::as_str) == Some("assistant");
        let Some(calls) = messages[index]
            .get_mut("tool_calls")
            .and_then(Value::as_array_mut)
            .filter(|_| is_assistant)
        else {
            continue;
        };
        let mut used = HashSet::new();
        let mut new_ids = Vec::with_capacity(calls.len());
        for (position, call) in calls.iter_mut().enumerate() {
            let Some(call) = call.as_object_mut() else {
                continue;
            };
            // The same pass fills a missing type and stringifies arguments.
            if call.get("type").is_none_or(Value::is_null) {
                call.insert("type".to_owned(), Value::String("function".to_owned()));
            }
            if let Some(function) = call.get_mut("function").and_then(Value::as_object_mut) {
                if let Some(arguments) = function
                    .get("arguments")
                    .filter(|arguments| !arguments.is_string() && !arguments.is_null())
                {
                    let encoded = arguments.to_string();
                    function.insert("arguments".to_owned(), Value::String(encoded));
                }
            }
            let original = call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let id = nine_char_id(&original, (index, position), &mut used);
            call.insert("id".to_owned(), Value::String(id.clone()));
            new_ids.push(id);
        }
        // Tool responses follow in tool_calls order, up to the next assistant turn.
        let mut next = new_ids.into_iter();
        for later in messages.iter_mut().skip(index + 1) {
            match later.get("role").and_then(Value::as_str) {
                Some("assistant") => break,
                Some("tool") => match (next.next(), later.as_object_mut()) {
                    (Some(id), Some(object)) => {
                        object.insert("tool_call_id".to_owned(), Value::String(id));
                    }
                    _ => break,
                },
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn is_nine_alphanumeric(value: &Value) -> bool {
        value
            .as_str()
            .is_some_and(|id| id.len() == 9 && id.bytes().all(|b| b.is_ascii_alphanumeric()))
    }

    #[test]
    fn assistant_tool_calls_and_their_responses_share_new_nine_char_ids() {
        let mut body = json!({"messages":[
            {"role":"user","content":"hi"},
            {"role":"assistant","tool_calls":[
                {"id":"call_abc_long_identifier","type":"function","function":{"name":"a","arguments":"{}"}},
                {"id":"call_def_long_identifier","type":"function","function":{"name":"b","arguments":"{}"}}
            ]},
            {"role":"tool","tool_call_id":"call_abc_long_identifier","content":"A"},
            {"role":"tool","tool_call_id":"call_def_long_identifier","content":"B"},
            {"role":"assistant","content":"done"},
            {"role":"tool","tool_call_id":"orphan","content":"C"}
        ]});
        normalize_tool_call_ids(&mut body);
        let calls = &body["messages"][1]["tool_calls"];
        assert!(is_nine_alphanumeric(&calls[0]["id"]));
        assert!(is_nine_alphanumeric(&calls[1]["id"]));
        assert_ne!(calls[0]["id"], calls[1]["id"]);
        assert_eq!(body["messages"][2]["tool_call_id"], calls[0]["id"]);
        assert_eq!(body["messages"][3]["tool_call_id"], calls[1]["id"]);
        // A later turn's responses are not relinked to an earlier assistant.
        assert_eq!(body["messages"][5]["tool_call_id"], "orphan");
    }

    #[test]
    fn missing_types_are_filled_and_object_arguments_stringified() {
        let mut body = json!({"messages":[
            {"role":"assistant","tool_calls":[{"id":"x","function":{"name":"a","arguments":{"q":1}}}]}
        ]});
        normalize_tool_call_ids(&mut body);
        let call = &body["messages"][0]["tool_calls"][0];
        assert_eq!(call["type"], "function");
        assert_eq!(call["function"]["arguments"], r#"{"q":1}"#);
    }

    #[test]
    fn ids_are_stable_for_the_same_history() {
        let body = json!({"messages":[
            {"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":{"name":"a","arguments":"{}"}}]},
            {"role":"tool","tool_call_id":"call_1","content":"A"}
        ]});
        let (mut first, mut second) = (body.clone(), body);
        normalize_tool_call_ids(&mut first);
        normalize_tool_call_ids(&mut second);
        assert_eq!(first, second);
    }

    #[test]
    fn bodies_without_tool_calls_are_unchanged() {
        let body = json!({"messages":[{"role":"user","content":"hi"}],"model":"m"});
        let mut changed = body.clone();
        normalize_tool_call_ids(&mut changed);
        assert_eq!(changed, body);
        let mut no_messages = json!({"input":"x"});
        normalize_tool_call_ids(&mut no_messages);
        assert_eq!(no_messages, json!({"input":"x"}));
    }
}
