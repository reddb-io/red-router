//! Per-stream state of the Responses to Chat translation and the functions
//! that read it, ported from the legacy
//! `openai-responses/synthesizeCompletedToolCalls.ts`.

use crate::responses_stream_pure::{
    normalize_tool_name, strip_empty_optional_tool_args_str, strip_empty_optional_tool_args_value,
    UpstreamFailure,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

/// A function call that was opened but not yet closed (legacy
/// `toolCallByCallId` entry).
#[derive(Debug, Clone, Default)]
pub struct ToolCallEntry {
    /// The chat tool call index, claimed when the call gets a name.
    pub index: Option<u64>,
    pub name: String,
    pub args_buffer: String,
    /// The name was empty at `output_item.added`; emission waits for `.done`.
    pub deferred: bool,
    pub needs_normalization: bool,
}

/// The state the Responses to Chat stream translator keeps between events.
/// Only the fields the synthesis path reads and writes live here so far; the
/// main translator adds its own as it is ported.
#[derive(Debug, Clone, Default)]
pub struct ResponsesStreamState {
    pub chat_id: String,
    pub created: i64,
    pub model: Option<String>,
    /// Tool calls already closed this turn.
    pub tool_call_index: u64,
    /// The call announced but not yet closed.
    pub current_tool_call_id: Option<String>,
    pub current_tool_call_args_buffer: String,
    pub current_tool_call_deferred: bool,
    /// `call_id`s the incremental events already emitted.
    pub tool_call_ids_seen: HashSet<String>,
    pub finish_reason_sent: bool,
    pub finish_reason: Option<String>,
    pub usage: Option<Value>,
    pub role_emitted: bool,
    /// The request's tool schemas by tool name.
    pub tool_schemas: HashMap<String, Value>,
    /// The first event arrived.
    pub started: bool,
    /// Calls in flight, in the order they were opened.
    pub tool_call_by_call_id: Vec<(String, ToolCallEntry)>,
    pub tool_call_item_to_call_id: HashMap<String, String>,
    /// Keyed by the JSON text of the event's `output_index`.
    pub tool_call_output_index_to_call_id: HashMap<String, String>,
    pub reasoning_delta_emitted: bool,
    pub reasoning_items_with_delta: HashSet<String>,
    /// The last summary index per reasoning item; `None` is the legacy `null`.
    pub reasoning_summary_index: HashMap<String, Option<f64>>,
    pub accumulated_reasoning: String,
    pub upstream_error: Option<UpstreamFailure>,
    /// The completed calls by index, shared with the Claude translation; only
    /// kept when the caller provides the map.
    pub tool_calls: Option<BTreeMap<u64, Value>>,
    pub copilot_compatible_reasoning: bool,
}

/// Legacy `fallbackToolCallId(index)`: an id for a call the provider left
/// anonymous.
pub fn fallback_tool_call_id(index: Option<u64>, now_ms: u128) -> String {
    match index {
        None => format!("call_{now_ms}"),
        Some(index) => format!("call_{index}_{now_ms}"),
    }
}

/// Legacy `computeFinishReason`: `tool_calls` once a call was emitted. The
/// open call counts too, so a stream that ends before its `output_item.done`
/// still finishes as `tool_calls` and the client keeps going.
pub fn compute_finish_reason(state: &ResponsesStreamState) -> &'static str {
    // An empty id is falsy in the legacy check.
    if state.tool_call_index > 0
        || state
            .current_tool_call_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
    {
        "tool_calls"
    } else {
        "stop"
    }
}

/// Legacy `withAssistantRoleOnFirstDelta`: a Chat stream announces the
/// assistant role on its first delta, which the Responses API has no event
/// for. Strict clients (`@langchain/openai`, hence n8n agents) drop streamed
/// tool call deltas without it.
pub fn with_assistant_role_on_first_delta(state: &mut ResponsesStreamState, chunks: &mut [Value]) {
    if state.role_emitted {
        return;
    }
    for chunk in chunks {
        if let Some(delta) = chunk
            .get_mut("choices")
            .and_then(|choices| choices.get_mut(0))
            .and_then(|choice| choice.get_mut("delta"))
            .and_then(Value::as_object_mut)
        {
            delta.insert("role".to_owned(), json!("assistant"));
            state.role_emitted = true;
            return;
        }
    }
}

pub(crate) fn base_chunk(state: &ResponsesStreamState) -> Map<String, Value> {
    let mut chunk = Map::new();
    chunk.insert("id".to_owned(), json!(state.chat_id));
    chunk.insert("object".to_owned(), json!("chat.completion.chunk"));
    chunk.insert("created".to_owned(), json!(state.created));
    let model = state
        .model
        .as_deref()
        .filter(|model| !model.is_empty())
        .unwrap_or("gpt-4");
    chunk.insert("model".to_owned(), json!(model));
    chunk
}

pub(crate) fn chunk_with(state: &ResponsesStreamState, choice: Value) -> Value {
    let mut chunk = base_chunk(state);
    chunk.insert("choices".to_owned(), json!([choice]));
    Value::Object(chunk)
}

/// The arguments string to emit, which may arrive as a string or an object.
fn resolve_args(raw: Option<&Value>, tool_name: &str, schema: Option<&Value>) -> String {
    match raw {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => strip_empty_optional_tool_args_str(text, tool_name, schema),
        Some(value @ Value::Object(_)) => serde_json::to_string(
            &strip_empty_optional_tool_args_value(value, tool_name, schema),
        )
        .unwrap_or_default(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// The header and arguments chunks of one synthesized function call, moving
/// the state exactly as the incremental `output_item.added` and `.done` path
/// would.
fn tool_call_chunks(state: &mut ResponsesStreamState, item: &Value, now_ms: u128) -> Vec<Value> {
    let call_id = item
        .get("call_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map_or_else(
            || fallback_tool_call_id(Some(state.tool_call_index), now_ms),
            str::to_owned,
        );
    let tool_name = normalize_tool_name(item.get("name").unwrap_or(&Value::Null));
    let schema = state.tool_schemas.get(&tool_name).cloned();

    state.current_tool_call_id = Some(call_id.clone());
    state.current_tool_call_args_buffer.clear();
    state.current_tool_call_deferred = false;

    let index = state.tool_call_index;
    let mut chunks = vec![chunk_with(
        state,
        json!({
            "index": 0,
            "delta": {"tool_calls": [{
                "index": index,
                "id": call_id,
                "type": "function",
                "function": {"name": tool_name, "arguments": ""},
            }]},
            "finish_reason": null,
        }),
    )];
    let arguments = resolve_args(item.get("arguments"), &tool_name, schema.as_ref());
    if !arguments.is_empty() {
        state.current_tool_call_args_buffer.clone_from(&arguments);
        chunks.push(chunk_with(
            state,
            json!({
                "index": 0,
                "delta": {"tool_calls": [{"index": index, "function": {"arguments": arguments}}]},
                "finish_reason": null,
            }),
        ));
    }

    state.tool_call_index += 1;
    state.current_tool_call_args_buffer.clear();
    state.current_tool_call_id = None;
    chunks
}

/// The terminal chunk, with usage, once every tool call is synthesized.
fn final_chunk(state: &mut ResponsesStreamState) -> Value {
    state.finish_reason_sent = true;
    let reason = compute_finish_reason(state);
    state.finish_reason = Some(reason.to_owned());
    let mut chunk = base_chunk(state);
    chunk.insert(
        "choices".to_owned(),
        json!([{"index": 0, "delta": {}, "finish_reason": reason}]),
    );
    if let Some(usage) = state
        .usage
        .as_ref()
        .filter(|usage| usage.is_object() || usage.is_array())
    {
        chunk.insert("usage".to_owned(), usage.clone());
    }
    Value::Object(chunk)
}

/// Legacy `synthesizeCompletedToolCalls`: tool call chunks for the
/// `function_call` items of a `response.completed` snapshot that the
/// incremental events never emitted (a provider that sends one batched
/// completion). Without them `finish_reason` would come out `stop` and break
/// the client's agent loop. Calls already seen are skipped so a provider that
/// streams and also echoes the snapshot does not emit twice. `None` when
/// there is nothing to synthesize or the finish was already sent.
pub fn synthesize_completed_tool_calls(
    state: &mut ResponsesStreamState,
    output: &Value,
    now_ms: u128,
) -> Option<Vec<Value>> {
    let empty = Vec::new();
    let items: Vec<&Value> = output
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|item| {
            item.get("type").and_then(Value::as_str) == Some("function_call")
                && !item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| state.tool_call_ids_seen.contains(id))
        })
        .collect();
    if items.is_empty() || state.finish_reason_sent {
        return None;
    }
    let mut chunks = Vec::new();
    for item in items {
        chunks.extend(tool_call_chunks(state, item, now_ms));
    }
    chunks.push(final_chunk(state));
    Some(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_from(value: &Value) -> ResponsesStreamState {
        ResponsesStreamState {
            chat_id: value["chatId"].as_str().unwrap_or("").to_owned(),
            created: value["created"].as_i64().unwrap_or(0),
            model: value["model"].as_str().map(str::to_owned),
            tool_call_index: value["toolCallIndex"].as_u64().unwrap_or(0),
            current_tool_call_id: value["currentToolCallId"].as_str().map(str::to_owned),
            tool_call_ids_seen: value["toolCallIdsSeen"]
                .as_array()
                .map(|ids| {
                    ids.iter()
                        .filter_map(|id| id.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            finish_reason_sent: value["finishReasonSent"].as_bool().unwrap_or(false),
            usage: (!value["usage"].is_null()).then(|| value["usage"].clone()),
            role_emitted: value["roleEmitted"].as_bool().unwrap_or(false),
            tool_schemas: value["toolSchemas"]
                .as_object()
                .map(|schemas| {
                    schemas
                        .iter()
                        .map(|(key, schema)| (key.clone(), schema.clone()))
                        .collect()
                })
                .unwrap_or_default(),
            ..ResponsesStreamState::default()
        }
    }

    fn snapshot(state: &ResponsesStreamState) -> Value {
        json!({
            "toolCallIndex": state.tool_call_index,
            "currentToolCallId": state.current_tool_call_id,
            "currentToolCallArgsBuffer": state.current_tool_call_args_buffer,
            "currentToolCallDeferred": state.current_tool_call_deferred,
            "finishReasonSent": state.finish_reason_sent,
            "finishReason": state.finish_reason,
            "roleEmitted": state.role_emitted,
        })
    }

    /// Chunks and state the legacy functions produced for the same inputs
    /// (`responses_stream_state_oracle.json`, generated with Node, with the
    /// clock fixed).
    #[test]
    fn synthesis_matches_the_legacy_implementation() {
        let oracle: Value =
            serde_json::from_str(include_str!("responses_stream_state_oracle.json")).unwrap();
        for case in oracle["synthesize"].as_array().unwrap() {
            let mut state = state_from(&case["state"]);
            let chunks =
                synthesize_completed_tool_calls(&mut state, &case["output"], 1_700_000_000_000);
            assert_eq!(
                chunks.map_or(Value::Null, Value::Array),
                case["chunks"],
                "{case}"
            );
            assert_eq!(snapshot(&state), case["after"], "{case}");
        }
        for case in oracle["role"].as_array().unwrap() {
            let mut state = state_from(&case["state"]);
            let mut chunks: Vec<Value> = case["chunks"].as_array().unwrap().clone();
            with_assistant_role_on_first_delta(&mut state, &mut chunks);
            assert_eq!(Value::Array(chunks), case["result"], "{case}");
            assert_eq!(state.role_emitted, case["roleEmitted"], "{case}");
        }
        for case in oracle["finish"].as_array().unwrap() {
            let state = state_from(&case["state"]);
            assert_eq!(compute_finish_reason(&state), case["reason"], "{case}");
        }
        assert_eq!(fallback_tool_call_id(None, 5), "call_5");
        assert_eq!(fallback_tool_call_id(Some(2), 5), "call_2_5");
    }
}
