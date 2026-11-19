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
//!
//! The module also ports the rest of the legacy tool-call integrity pass:
//! the default `ensureToolCallIds` path, `fixMissingToolResponses` and
//! `stripOrphanedToolResults`.

use serde_json::{json, Value};
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

/// JavaScript `String(id)` for a tool call ID.
fn id_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
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

fn blank_id(value: Option<&Value>) -> bool {
    value
        .filter(|value| !value.is_null())
        .is_none_or(|value| id_string(value).trim().is_empty())
}

fn role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

/// The default path of the legacy `ensureToolCallIds`: fill a missing type,
/// stringify object arguments and give every call an ID, keeping the
/// client's. Tool responses without an ID take the new ones in order, up to
/// the next assistant message; explicit response IDs are never overwritten.
pub(crate) fn ensure_tool_call_ids(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for index in 0..messages.len() {
        let is_assistant = role(&messages[index]) == Some("assistant");
        let Some(calls) = messages[index]
            .get_mut("tool_calls")
            .and_then(Value::as_array_mut)
            .filter(|_| is_assistant)
        else {
            continue;
        };
        let mut used = HashSet::new();
        let mut ids = Vec::with_capacity(calls.len());
        for (position, call) in calls.iter_mut().enumerate() {
            let Some(call) = call.as_object_mut() else {
                continue;
            };
            if !truthy(call.get("type")) {
                call.insert("type".to_owned(), Value::String("function".to_owned()));
            }
            if let Some(function) = call.get_mut("function").and_then(Value::as_object_mut) {
                if let Some(arguments) = function
                    .get("arguments")
                    .filter(|arguments| truthy(Some(arguments)) && !arguments.is_string())
                {
                    let encoded = arguments.to_string();
                    function.insert("arguments".to_owned(), Value::String(encoded));
                }
            }
            // The legacy ID is random; a derived one keeps history stable.
            let id = if blank_id(call.get("id")) {
                format!("call_{}", nine_char_id("", (index, position), &mut used))
            } else {
                id_string(&call["id"])
            };
            call.insert("id".to_owned(), Value::String(id.clone()));
            ids.push(id);
        }
        let mut next = ids.into_iter();
        for later in messages.iter_mut().skip(index + 1) {
            match role(later) {
                Some("assistant") => break,
                Some("tool") => {
                    let Some(id) = next.next() else {
                        break;
                    };
                    if let Some(object) = later.as_object_mut() {
                        if blank_id(object.get("tool_call_id")) {
                            object.insert("tool_call_id".to_owned(), Value::String(id));
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

/// Legacy `getToolCallIds`: OpenAI `tool_calls` and Claude `tool_use` blocks
/// of an assistant message.
fn tool_call_ids(message: &Value) -> Vec<String> {
    if role(message) != Some("assistant") {
        return Vec::new();
    }
    let calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|call| call.get("id").filter(|id| truthy(Some(id))));
    let blocks = message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|block| block.get("id").filter(|id| truthy(Some(id))));
    calls.chain(blocks).map(id_string).collect()
}

/// Legacy `hasToolResults`.
fn has_tool_results(message: &Value, ids: &[String]) -> bool {
    match role(message) {
        Some("tool") if truthy(message.get("tool_call_id")) => {
            ids.contains(&id_string(&message["tool_call_id"]))
        }
        Some("user") => message
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|blocks| {
                blocks.iter().any(|block| {
                    block.get("type").and_then(Value::as_str) == Some("tool_result")
                        && block
                            .get("tool_use_id")
                            .filter(|id| truthy(Some(id)))
                            .is_some_and(|id| ids.contains(&id_string(id)))
                })
            }),
        _ => false,
    }
}

/// Legacy `fixMissingToolResponses`: when the message after a tool-calling
/// assistant turn carries none of its results, empty results are inserted in
/// the turn's own shape (`tool` messages, or a user message of `tool_result`
/// blocks for Claude-style `tool_use`).
pub(crate) fn fix_missing_tool_responses(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let original = std::mem::take(messages);
    let mut fixed = Vec::with_capacity(original.len());
    for (index, message) in original.iter().enumerate() {
        fixed.push(message.clone());
        let ids = tool_call_ids(message);
        if ids.is_empty() {
            continue;
        }
        let Some(next) = original.get(index + 1) else {
            continue;
        };
        if has_tool_results(next, &ids) {
            continue;
        }
        let openai_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|calls| !calls.is_empty());
        if openai_calls {
            fixed.extend(
                ids.into_iter()
                    .map(|id| json!({"role":"tool","tool_call_id":id,"content":""})),
            );
        } else {
            let results: Vec<Value> = ids
                .into_iter()
                .map(|id| json!({"type":"tool_result","tool_use_id":id,"content":""}))
                .collect();
            fixed.push(json!({"role":"user","content":results}));
        }
    }
    *messages = fixed;
}

/// Legacy `stripOrphanedToolResults`: tool results whose call no longer
/// exists anywhere in the conversation (client-side compaction) are dropped,
/// and a message left with no content goes with them.
pub(crate) fn strip_orphaned_tool_results(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let known: HashSet<String> = messages.iter().flat_map(tool_call_ids).collect();
    messages.retain_mut(|message| {
        if role(message) == Some("tool") && truthy(message.get("tool_call_id")) {
            return known.contains(&id_string(&message["tool_call_id"]));
        }
        let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) else {
            return true;
        };
        let before = blocks.len();
        blocks.retain(|block| {
            block.get("type").and_then(Value::as_str) != Some("tool_result")
                || block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| known.contains(id))
        });
        before == blocks.len() || !blocks.is_empty()
    });
}

/// The legacy tool-call integrity pass of `translateRequest`: IDs (nine
/// characters when the model requires them), missing results, then orphans.
pub(crate) fn repair_tool_calls(body: &mut Value, nine_char_ids: bool) {
    if nine_char_ids {
        normalize_tool_call_ids(body);
    } else {
        ensure_tool_call_ids(body);
    }
    fix_missing_tool_responses(body);
    strip_orphaned_tool_results(body);
}

#[cfg(test)]
mod integrity_tests {
    use super::*;

    #[test]
    fn missing_ids_are_filled_and_relinked_without_overwriting_explicit_ones() {
        let mut body = json!({"messages":[
            {"role":"assistant","tool_calls":[
                {"function":{"name":"a","arguments":{"q":1}}},
                {"id":42,"type":"function","function":{"name":"b","arguments":"{}"}}
            ]},
            {"role":"tool","content":"A"},
            {"role":"tool","tool_call_id":"explicit","content":"B"}
        ]});
        ensure_tool_call_ids(&mut body);
        let calls = &body["messages"][0]["tool_calls"];
        let generated = calls[0]["id"].as_str().unwrap().to_owned();
        assert!(generated.starts_with("call_") && generated.len() == 14);
        assert_eq!(calls[0]["type"], "function");
        assert_eq!(calls[0]["function"]["arguments"], "{\"q\":1}");
        assert_eq!(calls[1]["id"], "42");
        assert_eq!(body["messages"][1]["tool_call_id"], generated.as_str());
        assert_eq!(body["messages"][2]["tool_call_id"], "explicit");
        // Derived IDs are stable across repeated turns.
        let mut again = body.clone();
        ensure_tool_call_ids(&mut again);
        assert_eq!(again, body);
    }

    #[test]
    fn unanswered_calls_get_empty_results_in_their_own_shape() {
        let mut body = json!({"messages":[
            {"role":"assistant","tool_calls":[{"id":"a"},{"id":"b"}]},
            {"role":"user","content":"next"},
            {"role":"assistant","content":[{"type":"tool_use","id":"c"}]},
            {"role":"user","content":"again"},
            {"role":"assistant","tool_calls":[{"id":"d"}]},
            {"role":"tool","tool_call_id":"d","content":"done"},
            {"role":"assistant","tool_calls":[{"id":"last"}]}
        ]});
        fix_missing_tool_responses(&mut body);
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 10);
        assert_eq!(
            messages[1],
            json!({"role":"tool","tool_call_id":"a","content":""})
        );
        assert_eq!(
            messages[2],
            json!({"role":"tool","tool_call_id":"b","content":""})
        );
        assert_eq!(
            messages[5],
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"c","content":""}]})
        );
        // An answered turn and a trailing turn are left alone.
        assert_eq!(messages[8]["tool_call_id"], "d");
        assert_eq!(messages[9]["tool_calls"][0]["id"], "last");
    }

    #[test]
    fn orphaned_results_are_dropped_with_their_emptied_messages() {
        let mut body = json!({"messages":[
            {"role":"tool","tool_call_id":"gone","content":"stale"},
            {"role":"assistant","tool_calls":[{"id":"kept"}]},
            {"role":"tool","tool_call_id":"kept","content":"ok"},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"gone"}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"gone"},{"type":"text","text":"hi"}]},
            {"role":"tool","content":"no id"}
        ]});
        strip_orphaned_tool_results(&mut body);
        assert_eq!(
            body["messages"],
            json!([
                {"role":"assistant","tool_calls":[{"id":"kept"}]},
                {"role":"tool","tool_call_id":"kept","content":"ok"},
                {"role":"user","content":[{"type":"text","text":"hi"}]},
                {"role":"tool","content":"no id"}
            ])
        );
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
