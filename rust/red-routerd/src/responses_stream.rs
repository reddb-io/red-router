//! The Responses API stream to Chat Completions chunk translation, ported
//! from `openaiResponsesToOpenAIResponse` and its helpers in the legacy
//! `translator/response/openai-responses.ts`.
//!
//! This is for a Codex or Responses upstream answering an OpenAI-compatible
//! client: each upstream event maps to zero or more Chat chunks, and the
//! translator state carries the tool calls in flight, the reasoning bookkeeping
//! and the finish reason across events.

use crate::reasoning_placeholder::is_internal_reasoning_placeholder;
use crate::responses_stream_pure::{
    extract_reasoning_summary_text, extract_replayable_reasoning_text, normalize_tool_name,
    normalize_upstream_failure, strip_empty_optional_tool_args_str,
    strip_empty_optional_tool_args_value,
};
use crate::responses_stream_state::{
    base_chunk, chunk_with, compute_finish_reason, fallback_tool_call_id,
    synthesize_completed_tool_calls, with_assistant_role_on_first_delta, ResponsesStreamState,
    ToolCallEntry,
};
use serde_json::{json, Map, Value};

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// A JavaScript number as JSON: integral values print without a fraction.
fn number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        Value::Number(serde_json::Number::from_f64(value).unwrap_or_else(|| 0.into()))
    }
}

/// The `String(value)` of an id, or empty for `null` and `undefined`.
fn id_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

fn key_of(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn delta_chunk(state: &ResponsesStreamState, delta: Value) -> Value {
    chunk_with(
        state,
        json!({"index": 0, "delta": delta, "finish_reason": null}),
    )
}

/// Legacy `markResponsesReasoningDeltaEmitted`.
fn mark_reasoning_delta_emitted(state: &mut ResponsesStreamState, item_id: Option<&Value>) {
    state.reasoning_delta_emitted = true;
    let id = id_text(item_id);
    if !id.is_empty() {
        state.reasoning_items_with_delta.insert(id);
    }
}

/// Legacy `buildResponsesReasoningSummaryDelta` (#9500): when `summary_index`
/// advances for an item that already emitted a delta, a new summary segment
/// begins and gets a blank line before it. Never on the first segment.
fn reasoning_summary_delta(state: &mut ResponsesStreamState, data: &Value, delta: &str) -> String {
    let item_id = id_text(data.get("item_id"));
    let summary_index = data.get("summary_index").and_then(Value::as_f64);
    // A `null` summary index compares as 0, as in JavaScript.
    let compared = summary_index.unwrap_or(0.0);
    let last = if item_id.is_empty() {
        None
    } else {
        state.reasoning_summary_index.get(&item_id).copied()
    };
    let already_emitted = if item_id.is_empty() {
        state.reasoning_delta_emitted
    } else {
        state.reasoning_items_with_delta.contains(&item_id)
    };
    let mut text = delta.to_owned();
    if summary_index.is_some()
        && last.is_some_and(|last| compared > last.unwrap_or(0.0))
        && already_emitted
    {
        text = format!("\n\n{delta}");
    }
    if !item_id.is_empty() && last.is_none_or(|last| compared > last.unwrap_or(0.0)) {
        state.reasoning_summary_index.insert(item_id, summary_index);
    }
    text
}

/// Legacy `buildResponsesReasoningDeltaChunk` (#5786): a Chat reasoning delta
/// in the field the client's thinking panel renders, or `None` for the
/// internal replay placeholder.
fn reasoning_delta_chunk(state: &ResponsesStreamState, text: &str) -> Option<Value> {
    if is_internal_reasoning_placeholder(Some(&Value::String(text.to_owned()))) {
        return None;
    }
    let delta = if state.copilot_compatible_reasoning {
        json!({"reasoning_text": text})
    } else {
        json!({"reasoning_content": text})
    };
    Some(delta_chunk(state, delta))
}

fn finish_chunk(state: &ResponsesStreamState, reason: &str, usage: bool) -> Value {
    let mut chunk = base_chunk(state);
    chunk.insert(
        "choices".to_owned(),
        json!([{"index": 0, "delta": {}, "finish_reason": reason}]),
    );
    if usage {
        if let Some(usage) = state
            .usage
            .as_ref()
            .filter(|usage| usage.is_object() || usage.is_array())
        {
            chunk.insert("usage".to_owned(), usage.clone());
        }
    }
    Value::Object(chunk)
}

fn entry_position(state: &ResponsesStreamState, call_id: &str) -> Option<usize> {
    state
        .tool_call_by_call_id
        .iter()
        .position(|(id, _)| id == call_id)
}

/// The arguments text to emit for a terminal value: a string cleaned, an
/// object cleaned and serialized.
fn clean_arguments(value: &Value, tool_name: &str, schema: Option<&Value>) -> String {
    match value {
        Value::String(text) => strip_empty_optional_tool_args_str(text, tool_name, schema),
        other => serde_json::to_string(&strip_empty_optional_tool_args_value(
            other, tool_name, schema,
        ))
        .unwrap_or_default(),
    }
}

/// The arguments a closing function call carries: its own `arguments` when
/// non-empty, else what the deltas buffered.
fn terminal_arguments(item: &Value, buffered: &str) -> Value {
    match item.get("arguments") {
        Some(Value::String(text)) if !text.is_empty() => Value::String(text.clone()),
        Some(Value::String(_)) | None | Some(Value::Null) => Value::String(buffered.to_owned()),
        Some(other) => other.clone(),
    }
}

fn tool_call_delta_chunk(state: &ResponsesStreamState, tool_call: Value) -> Value {
    delta_chunk(state, json!({"tool_calls": [tool_call]}))
}

/// A `response.completed` usage block as Chat usage (legacy `state.usage`).
fn chat_usage(usage: &Map<String, Value>) -> Value {
    let get = |value: Option<&Value>| value.and_then(Value::as_f64).filter(|n| *n != 0.0);
    let nested =
        |outer: &str, inner: &str| get(usage.get(outer).and_then(|details| details.get(inner)));
    let input = get(usage.get("input_tokens"))
        .or_else(|| get(usage.get("prompt_tokens")))
        .unwrap_or(0.0);
    let output = get(usage.get("output_tokens"))
        .or_else(|| get(usage.get("completion_tokens")))
        .unwrap_or(0.0);
    let cache_read = get(usage.get("cache_read_input_tokens"))
        .or_else(|| nested("input_tokens_details", "cached_tokens"))
        .or_else(|| nested("prompt_tokens_details", "cached_tokens"))
        .unwrap_or(0.0);
    let cache_creation = get(usage.get("cache_creation_input_tokens")).unwrap_or(0.0);
    let reasoning = nested("output_tokens_details", "reasoning_tokens")
        .or_else(|| nested("completion_tokens_details", "reasoning_tokens"))
        .or_else(|| get(usage.get("reasoning_tokens")))
        .unwrap_or(0.0);
    let prompt = input
        + if usage.contains_key("cache_read_input_tokens") {
            cache_read + cache_creation
        } else {
            0.0
        };
    let mut out = Map::new();
    out.insert("prompt_tokens".to_owned(), number(prompt));
    out.insert("completion_tokens".to_owned(), number(output));
    out.insert("total_tokens".to_owned(), number(prompt + output));
    if cache_read > 0.0 || cache_creation > 0.0 {
        let mut details = Map::new();
        if cache_read > 0.0 {
            details.insert("cached_tokens".to_owned(), number(cache_read));
        }
        if cache_creation > 0.0 {
            details.insert("cache_creation_tokens".to_owned(), number(cache_creation));
        }
        out.insert("prompt_tokens_details".to_owned(), Value::Object(details));
    }
    if reasoning > 0.0 {
        out.insert(
            "completion_tokens_details".to_owned(),
            json!({"reasoning_tokens": number(reasoning)}),
        );
    }
    Value::Object(out)
}

/// The end of the upstream stream: flush every buffered call and send the
/// finish reason if no event did.
fn flush(state: &mut ResponsesStreamState, now_ms: u128) -> Vec<Value> {
    let mut pending: Vec<(Option<u64>, String)> = Vec::new();
    for (_, entry) in &mut state.tool_call_by_call_id {
        if entry.args_buffer.is_empty() {
            continue;
        }
        let schema = state.tool_schemas.get(&entry.name);
        let cleaned = strip_empty_optional_tool_args_str(&entry.args_buffer, &entry.name, schema);
        pending.push((entry.index, cleaned));
        entry.args_buffer.clear();
        entry.needs_normalization = false;
    }
    if !pending.is_empty() {
        state.finish_reason_sent = true;
        state.finish_reason = Some("tool_calls".to_owned());
        let mut chunks: Vec<Value> = pending
            .into_iter()
            .map(|(index, arguments)| {
                delta_chunk(
                    state,
                    json!({"tool_calls": [{"index": index, "function": {"arguments": arguments}}]}),
                )
            })
            .collect();
        chunks.push(finish_chunk(state, "tool_calls", false));
        return chunks;
    }
    if !state.finish_reason_sent && state.started {
        state.finish_reason_sent = true;
        let reason = compute_finish_reason(state);
        let mut chunk = finish_chunk(state, reason, false);
        if state.chat_id.is_empty() {
            chunk["id"] = json!(format!("chatcmpl-{now_ms}"));
        }
        if state.created == 0 {
            chunk["created"] = json!(now_ms / 1000);
        }
        return vec![chunk];
    }
    Vec::new()
}

fn handle_function_call_added(
    state: &mut ResponsesStreamState,
    data: &Value,
    item: &Value,
    now_ms: u128,
) -> Vec<Value> {
    let call_id = item
        .get("call_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map_or_else(|| fallback_tool_call_id(None, now_ms), str::to_owned);
    state.current_tool_call_id = Some(call_id.clone());
    let tool_name = normalize_tool_name(item.get("name").unwrap_or(&Value::Null));
    // The index is claimed now, at `.added`, so two calls opened before either
    // closes never share one. A still-nameless call claims none until `.done`.
    let index = if tool_name.is_empty() {
        None
    } else {
        let index = state.tool_call_index;
        state.tool_call_index = index + 1;
        Some(index)
    };
    let entry = ToolCallEntry {
        index,
        name: tool_name.clone(),
        args_buffer: String::new(),
        deferred: tool_name.is_empty(),
        needs_normalization: tool_name == "Agent",
    };
    match entry_position(state, &call_id) {
        Some(position) => state.tool_call_by_call_id[position].1 = entry,
        None => state.tool_call_by_call_id.push((call_id.clone(), entry)),
    }
    if let Some(item_id) = item.get("id").filter(|id| truthy(Some(id))) {
        state
            .tool_call_item_to_call_id
            .insert(id_text(Some(item_id)), call_id.clone());
    }
    if let Some(output_index) = data.get("output_index").filter(|value| !value.is_null()) {
        state
            .tool_call_output_index_to_call_id
            .insert(key_of(output_index), call_id.clone());
    }
    state.tool_call_ids_seen.insert(call_id.clone());
    if tool_name.is_empty() {
        // A provider may briefly send an empty name; wait for `.done`.
        return Vec::new();
    }
    vec![tool_call_delta_chunk(
        state,
        json!({"index": index, "id": call_id, "type": "function", "function": {"name": tool_name, "arguments": ""}}),
    )]
}

fn handle_arguments_delta(state: &mut ResponsesStreamState, data: &Value) -> Vec<Value> {
    let delta = data.get("delta");
    if !truthy(delta) {
        return Vec::new();
    }
    let delta_text = match delta {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    // Resolve the call by item id, then by output index, and only then guess:
    // the single open call, else the most recently opened one.
    let mut call_id: Option<String> = None;
    if truthy(data.get("item_id")) {
        call_id = state
            .tool_call_item_to_call_id
            .get(&id_text(data.get("item_id")))
            .cloned();
    }
    if call_id.is_none() {
        if let Some(output_index) = data.get("output_index").filter(|value| !value.is_null()) {
            call_id = state
                .tool_call_output_index_to_call_id
                .get(&key_of(output_index))
                .cloned();
        }
    }
    if call_id.is_none() {
        call_id = if state.tool_call_by_call_id.len() == 1 {
            Some(state.tool_call_by_call_id[0].0.clone())
        } else {
            state
                .current_tool_call_id
                .clone()
                .filter(|id| !id.is_empty())
        };
    }
    let Some(position) = call_id.and_then(|id| entry_position(state, &id)) else {
        return Vec::new();
    };
    // #9168: arguments are buffered until `.done` for schema-aware normalization.
    state.tool_call_by_call_id[position]
        .1
        .args_buffer
        .push_str(&delta_text);
    Vec::new()
}

fn handle_function_call_done(
    state: &mut ResponsesStreamState,
    item: &Value,
    now_ms: u128,
) -> Vec<Value> {
    let mut call_id = item
        .get("call_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    if call_id.is_none() && truthy(item.get("id")) {
        call_id = state
            .tool_call_item_to_call_id
            .get(&id_text(item.get("id")))
            .cloned();
    }
    let call_id = call_id.unwrap_or_else(|| {
        state
            .current_tool_call_id
            .clone()
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| fallback_tool_call_id(None, now_ms))
    });
    // Some upstreams send the whole call only here, with no `.added` at all.
    let mut entry = entry_position(state, &call_id)
        .map(|position| state.tool_call_by_call_id[position].1.clone())
        .unwrap_or_default();
    let buffered = entry.args_buffer.clone();
    let tool_name = normalize_tool_name(item.get("name").unwrap_or(&Value::Null));
    if entry.index.is_none() && !tool_name.is_empty() {
        let index = state.tool_call_index;
        state.tool_call_index = index + 1;
        entry.index = Some(index);
    }
    let current_index = entry.index;
    let schema = state.tool_schemas.get(&tool_name).cloned();
    let normalize_arguments = tool_name == "Agent";

    if !tool_name.is_empty() && state.tool_calls.is_some() {
        let completed = match item.get("arguments") {
            Some(Value::String(text)) if !text.is_empty() => text.clone(),
            _ => buffered.clone(),
        };
        let normalized =
            strip_empty_optional_tool_args_str(&completed, &tool_name, schema.as_ref());
        if let (Some(index), Some(calls)) = (current_index, state.tool_calls.as_mut()) {
            // Keep the fields a Claude translation added to the shared entry.
            let mut merged = calls
                .get(&index)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            merged.insert("id".to_owned(), json!(call_id));
            merged.insert("index".to_owned(), json!(index));
            merged.insert("type".to_owned(), json!("function"));
            merged.insert(
                "function".to_owned(),
                json!({"name": tool_name, "arguments": normalized}),
            );
            calls.insert(index, Value::Object(merged));
        }
    }

    // Tracked so `response.completed` does not synthesize a duplicate.
    state.tool_call_ids_seen.insert(call_id.clone());
    // The call is closed: drop it from the in-flight map.
    if let Some(position) = entry_position(state, &call_id) {
        state.tool_call_by_call_id.remove(position);
    }
    if state.current_tool_call_id.as_deref() == Some(call_id.as_str()) {
        state.current_tool_call_id = None;
    }

    if entry.deferred {
        if tool_name.is_empty() {
            return Vec::new();
        }
        let terminal = terminal_arguments(item, &buffered);
        let emitted = clean_arguments(&terminal, &tool_name, schema.as_ref());
        let arguments = if emitted.is_empty() {
            buffered.clone()
        } else {
            emitted
        };
        return vec![tool_call_delta_chunk(
            state,
            json!({"index": current_index, "id": call_id, "type": "function",
                   "function": {"name": tool_name, "arguments": arguments}}),
        )];
    }

    // Nullable omission sentinels are normalized before any argument bytes
    // reach the client; other calls keep streaming their arguments directly.
    let has_arguments =
        item.get("arguments").is_some_and(|value| !value.is_null()) || !buffered.is_empty();
    let source = if (normalize_arguments || buffered.is_empty()) && has_arguments {
        Some(clean_arguments(
            &terminal_arguments(item, &buffered),
            &tool_name,
            schema.as_ref(),
        ))
    } else if !buffered.is_empty() {
        Some(clean_arguments(
            &Value::String(buffered),
            &tool_name,
            schema.as_ref(),
        ))
    } else {
        None
    };
    match source.filter(|arguments| !arguments.is_empty()) {
        Some(arguments) => vec![tool_call_delta_chunk(
            state,
            json!({"index": current_index, "function": {"arguments": arguments}}),
        )],
        None => Vec::new(),
    }
}

fn handle_completed(state: &mut ResponsesStreamState, data: &Value, now_ms: u128) -> Vec<Value> {
    if let Some(usage) = data
        .get("response")
        .and_then(|response| response.get("usage"))
        .and_then(Value::as_object)
    {
        state.usage = Some(chat_usage(usage));
    }
    // A provider that batches everything into `response.completed` never sent
    // the incremental events; synthesize the tool calls from the snapshot.
    let output = data
        .get("response")
        .and_then(|response| response.get("output"))
        .unwrap_or(&Value::Null);
    if let Some(chunks) = synthesize_completed_tool_calls(state, output, now_ms) {
        return chunks;
    }
    if state.finish_reason_sent {
        return Vec::new();
    }
    state.finish_reason_sent = true;
    let reason = compute_finish_reason(state);
    state.finish_reason = Some(reason.to_owned());
    vec![finish_chunk(state, reason, true)]
}

fn handle_reasoning_done(state: &mut ResponsesStreamState, item: &Value) -> Vec<Value> {
    let item_id = id_text(item.get("id"));
    let emitted_for_item =
        !item_id.is_empty() && state.reasoning_items_with_delta.contains(&item_id);
    // Deltas streamed with no item id: suppress synthesis rather than repeat them.
    let emitted_without_item_id =
        state.reasoning_delta_emitted && state.reasoning_items_with_delta.is_empty();
    if emitted_for_item || emitted_without_item_id {
        return Vec::new();
    }
    let replayable = extract_replayable_reasoning_text(item);
    let text = if replayable.is_empty() {
        // #7176/#7243: only real upstream plaintext, never a placeholder for
        // encrypted-only reasoning.
        extract_reasoning_summary_text(item)
    } else {
        replayable
    };
    if text.is_empty() {
        return Vec::new();
    }
    reasoning_delta_chunk(state, &text).into_iter().collect()
}

fn translate(chunk: Option<&Value>, state: &mut ResponsesStreamState, now_ms: u128) -> Vec<Value> {
    let Some(chunk) = chunk.filter(|chunk| truthy(Some(chunk))) else {
        return flush(state, now_ms);
    };
    let event_type = ["type", "event"]
        .iter()
        .find_map(|key| chunk.get(*key).filter(|value| truthy(Some(value))))
        .and_then(Value::as_str);
    let data = chunk
        .get("data")
        .filter(|data| truthy(Some(data)))
        .unwrap_or(chunk);

    if state.model.as_deref().is_none_or(str::is_empty) {
        let upstream = data
            .get("response")
            .filter(|response| response.is_object())
            .and_then(|response| response.get("model"))
            .filter(|model| truthy(Some(model)))
            .or_else(|| data.get("model").filter(|model| truthy(Some(model))))
            .or_else(|| data.get("modelVersion").filter(|model| truthy(Some(model))))
            .or_else(|| {
                data.get("model_version")
                    .filter(|model| truthy(Some(model)))
            });
        if let Some(Value::String(model)) = upstream {
            let trimmed = model.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
            if !trimmed.is_empty() {
                state.model = Some(trimmed.to_owned());
            }
        }
    }

    if !state.started {
        state.started = true;
        state.chat_id = format!("chatcmpl-{now_ms}");
        state.created = i64::try_from(now_ms / 1000).unwrap_or(0);
        state.tool_call_index = 0;
        state.current_tool_call_id = None;
        state.tool_call_by_call_id = Vec::new();
        state.tool_call_item_to_call_id.clear();
        state.tool_call_output_index_to_call_id.clear();
    }

    let item = data.get("item");
    let item_type = item
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str);
    match event_type {
        Some("response.output_text.delta") => {
            let delta = data.get("delta").filter(|delta| truthy(Some(delta)));
            delta
                .map(|delta| vec![delta_chunk(state, json!({"content": delta}))])
                .unwrap_or_default()
        }
        Some("response.output_text.done") => Vec::new(),
        Some("response.output_item.added") if item_type == Some("function_call") => {
            handle_function_call_added(state, data, item.unwrap_or(&Value::Null), now_ms)
        }
        Some("response.function_call_arguments.delta") => handle_arguments_delta(state, data),
        Some("response.output_item.done") if item_type == Some("reasoning") => {
            let item = item.unwrap_or(&Value::Null);
            let replayable = extract_replayable_reasoning_text(item);
            if !replayable.is_empty() {
                state.accumulated_reasoning = if state.accumulated_reasoning.is_empty() {
                    replayable
                } else {
                    format!("{}\n\n{replayable}", state.accumulated_reasoning)
                };
            }
            handle_reasoning_done(state, item)
        }
        Some("response.output_item.done") if item_type == Some("function_call") => {
            handle_function_call_done(state, item.unwrap_or(&Value::Null), now_ms)
        }
        Some("response.completed") => handle_completed(state, data, now_ms),
        Some("response.failed" | "error") => {
            state.upstream_error = Some(normalize_upstream_failure(data, "server_error"));
            state.finish_reason_sent = true;
            Vec::new()
        }
        Some("response.reasoning_content_text.delta" | "response.reasoning_text.delta") => {
            let Some(delta) = data.get("delta").filter(|delta| truthy(Some(delta))) else {
                return Vec::new();
            };
            mark_reasoning_delta_emitted(state, data.get("item_id"));
            vec![delta_chunk(state, json!({"reasoning_content": delta}))]
        }
        // True reasoning summary ("Thought for 15s"), as `reasoning_content`.
        Some("response.reasoning_summary_text.delta") => {
            let Some(delta) = data
                .get("delta")
                .and_then(Value::as_str)
                .filter(|delta| !delta.is_empty())
            else {
                return Vec::new();
            };
            mark_reasoning_delta_emitted(state, data.get("item_id"));
            let text = reasoning_summary_delta(state, data, delta);
            reasoning_delta_chunk(state, &text).into_iter().collect()
        }
        _ => Vec::new(),
    }
}

/// Legacy `openaiResponsesToOpenAIResponse`: translate one Responses stream
/// event into Chat Completions chunks; `None` is the end of the stream, which
/// flushes whatever is still buffered. The first chunk announces the
/// assistant role. `now_ms` stamps the chat id and creation time.
pub fn openai_responses_to_openai_response(
    chunk: Option<&Value>,
    state: &mut ResponsesStreamState,
    now_ms: u128,
) -> Vec<Value> {
    let mut chunks = translate(chunk, state, now_ms);
    with_assistant_role_on_first_delta(state, &mut chunks);
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn state_from(value: &Value) -> ResponsesStreamState {
        ResponsesStreamState {
            copilot_compatible_reasoning: value["copilot"].as_bool().unwrap_or(false),
            tool_calls: value["withToolCalls"]
                .as_bool()
                .unwrap_or(false)
                .then(BTreeMap::new),
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

    /// Chunks the legacy translator produced for the same event sequences
    /// (`responses_stream_oracle.json`, generated with Node with the clock
    /// fixed).
    #[test]
    fn event_sequences_match_the_legacy_translator() {
        let oracle: Vec<Value> =
            serde_json::from_str(include_str!("responses_stream_oracle.json")).unwrap();
        assert!(oracle.len() >= 25, "{}", oracle.len());
        for case in &oracle {
            let mut state = state_from(&case["state"]);
            let mut produced = Vec::new();
            for event in case["events"].as_array().unwrap() {
                let chunk = (!event.is_null()).then_some(event);
                produced.push(Value::Array(openai_responses_to_openai_response(
                    chunk,
                    &mut state,
                    1_700_000_000_000,
                )));
            }
            assert_eq!(Value::Array(produced), case["chunks"], "{}", case["name"]);
            assert_eq!(
                state.finish_reason_sent, case["finishReasonSent"],
                "{}",
                case["name"]
            );
            assert_eq!(
                state.finish_reason.as_deref(),
                case["finishReason"].as_str(),
                "{}",
                case["name"]
            );
            assert_eq!(
                state.accumulated_reasoning,
                case["accumulatedReasoning"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                state.usage.clone().unwrap_or(Value::Null),
                case["usage"],
                "{}",
                case["name"]
            );
            assert_eq!(
                state.upstream_error.as_ref().map(|failure| failure.status),
                case["upstreamStatus"].as_u64().map(|status| status as u16),
                "{}",
                case["name"]
            );
        }
    }
}
