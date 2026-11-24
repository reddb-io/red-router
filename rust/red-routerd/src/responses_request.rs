//! OpenAI Chat Completions to Responses API request translation, ported from
//! the legacy `open-sse/translator/request/openai-responses/toResponses.ts`
//! (`openaiToOpenAIResponsesRequest`).

use crate::{
    reasoning_placeholder::{
        is_internal_reasoning_placeholder, requires_reasoning_content_presence,
    },
    responses_helpers::{
        build_instructions_text, build_text_parts, clamp_call_id, image_url_to_text,
        map_response_format, normalize_reasoning_effort, normalize_verbosity, readable_reasoning,
    },
};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;

/// The `_omnirouteResponsesStore` marker a caller sets to force `store`.
pub const RESPONSES_STORE_MARKER: &str = "_omnirouteResponsesStore";
const REASONING_SUMMARY: &str = "auto";
const ENCRYPTED_CONTENT_INCLUDE: &str = "reasoning.encrypted_content";

static DATA_URL_IMAGE: LazyLock<Regex> = LazyLock::new(|| {
    // JavaScript `.` excludes line terminators; `$` only matches at the end.
    Regex::new(r"^data:([^;]+);base64,([^\n\r\u{2028}\u{2029}]+)$").expect("static pattern")
});

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Legacy `toString(value, fallback)`: strings only.
fn string_or<'a>(value: Option<&'a Value>, fallback: &'a str) -> &'a str {
    value.and_then(Value::as_str).unwrap_or(fallback)
}

/// JavaScript `String(value ?? "")` for the shapes a message content takes.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| js_string(Some(item)))
            .collect::<Vec<_>>()
            .join(","),
    }
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// Legacy `generateToolCallId`: `call_<base36 ms>_<7 base36 characters>`.
pub fn generate_tool_call_id() -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    let mut stamp = Vec::new();
    while millis > 0 {
        stamp.push(DIGITS[(millis % 36) as usize]);
        millis /= 36;
    }
    if stamp.is_empty() {
        stamp.push(b'0');
    }
    stamp.reverse();
    let mut random = [0_u8; 7];
    let suffix: String = if getrandom::fill(&mut random).is_ok() {
        random
            .iter()
            .map(|byte| DIGITS[usize::from(*byte) % 36] as char)
            .collect()
    } else {
        "0000000".to_owned()
    };
    format!("call_{}_{suffix}", String::from_utf8_lossy(&stamp))
}

fn input_text(text: &str) -> Value {
    json!({"type": "input_text", "text": text})
}

fn user_content(content: Option<&Value>) -> Vec<Value> {
    match content {
        Some(Value::String(text)) => vec![input_text(text)],
        Some(Value::Array(items)) => items.iter().map(user_part).collect(),
        _ => vec![input_text("")],
    }
}

fn user_part(item: &Value) -> Value {
    let record = item.as_object();
    let field = |name: &str| record.and_then(|record| record.get(name));
    match field("type").and_then(Value::as_str) {
        Some("text") => input_text(string_or(field("text"), "")),
        Some("image_url") => {
            let image = field("image_url");
            let url = match image {
                Some(Value::String(url)) => Value::String(url.clone()),
                Some(Value::Object(object)) => match object.get("url") {
                    Some(url) if truthy(url) => url.clone(),
                    _ => Value::String(String::new()),
                },
                _ => Value::String(String::new()),
            };
            let mut result = Map::new();
            result.insert("type".to_owned(), json!("input_image"));
            result.insert("image_url".to_owned(), url);
            if let Some(Value::Object(object)) = image {
                if let Some(detail) = object.get("detail") {
                    result.insert("detail".to_owned(), detail.clone());
                }
            }
            Value::Object(result)
        }
        Some("image")
            if field("image")
                .and_then(Value::as_str)
                .is_some_and(|image| DATA_URL_IMAGE.is_match(image)) =>
        {
            json!({
                "type": "input_image",
                "image_url": field("image"),
                "detail": field("detail").cloned().unwrap_or_else(|| json!("auto")),
            })
        }
        Some(kind @ ("file" | "document")) => {
            let source = field(if kind == "document" {
                "document"
            } else {
                "file"
            })
            .and_then(Value::as_object);
            let get = |name: &str| source.and_then(|source| source.get(name));
            let mut result = Map::new();
            result.insert("type".to_owned(), json!("input_file"));
            for (target, primary, fallback) in [
                ("file_data", "file_data", Some("data")),
                ("file_id", "file_id", None),
                ("file_url", "file_url", Some("url")),
                ("filename", "filename", Some("name")),
            ] {
                if let Some(value) = get(primary).or_else(|| fallback.and_then(&get)) {
                    result.insert(target.to_owned(), value.clone());
                }
            }
            Value::Object(result)
        }
        _ => item.clone(),
    }
}

fn assistant_items(
    message: &Map<String, Value>,
    provider: Option<&str>,
    model: &str,
    new_call_id: &mut dyn FnMut() -> String,
    input: &mut Vec<Value>,
) {
    let reasoning = js_trim(&readable_reasoning(&Value::Object(message.clone()))).to_owned();
    let placeholder = is_internal_reasoning_placeholder(Some(&Value::String(reasoning.clone())));
    let reasoning_item = json!({
        "type": "reasoning",
        "content": [{"type": "reasoning_text", "text": reasoning}],
        "summary": [],
    });
    // Real reasoning is replayed as plaintext; the internal placeholder only
    // where the upstream rejects an assistant turn without reasoning (#9573).
    let presence_required =
        placeholder && requires_reasoning_content_presence(provider.unwrap_or(""), model);
    if (!reasoning.is_empty() && !placeholder) || presence_required {
        input.push(reasoning_item);
    }

    let mut output = Vec::new();
    match message.get("content") {
        Some(Value::String(text)) if !text.is_empty() => {
            output.push(json!({"type": "output_text", "text": text}));
        }
        Some(Value::Array(items)) => {
            for item in items {
                let record = item.as_object();
                match record
                    .and_then(|record| record.get("type"))
                    .and_then(Value::as_str)
                {
                    Some("text") => output.push(json!({
                        "type": "output_text",
                        "text": string_or(record.and_then(|record| record.get("text")), ""),
                    })),
                    Some("image_url") => {
                        let url = image_url_to_text(
                            record
                                .and_then(|record| record.get("image_url"))
                                .unwrap_or(&Value::Null),
                        );
                        let text = if url.is_empty() {
                            "[Image]".to_owned()
                        } else {
                            format!("[Image: {url}]")
                        };
                        output.push(json!({"type": "output_text", "text": text}));
                    }
                    Some("thinking" | "redacted_thinking") => {}
                    _ => output.push(item.clone()),
                }
            }
        }
        _ => {}
    }
    if !output.is_empty() {
        input.push(json!({"type": "message", "role": "assistant", "content": output, "status": "completed"}));
    }

    if let Some(Value::Array(calls)) = message.get("tool_calls") {
        for call in calls {
            let call = call.as_object();
            let function = call
                .and_then(|call| call.get("function"))
                .and_then(Value::as_object);
            let name = js_trim(string_or(
                function.and_then(|function| function.get("name")),
                "",
            ));
            if name.is_empty() {
                continue;
            }
            let id = js_trim(string_or(call.and_then(|call| call.get("id")), ""));
            let id = if id.is_empty() {
                new_call_id()
            } else {
                id.to_owned()
            };
            input.push(json!({
                "type": "function_call",
                "call_id": clamp_call_id(&id),
                "name": name,
                "arguments": string_or(function.and_then(|function| function.get("arguments")), "{}"),
                "status": "completed",
            }));
        }
    }

    // The deprecated `function_call` field, from before `tool_calls`.
    if message.get("function_call").is_some_and(truthy)
        && !message.get("tool_calls").is_some_and(truthy)
    {
        let call = message.get("function_call").and_then(Value::as_object);
        let name = js_trim(string_or(call.and_then(|call| call.get("name")), ""));
        if !name.is_empty() {
            input.push(json!({
                "type": "function_call",
                "call_id": clamp_call_id(&format!("call_{name}")),
                "name": name,
                "arguments": string_or(call.and_then(|call| call.get("arguments")), "{}"),
                "status": "completed",
            }));
        }
    }
}

fn tool_output(content: Option<&Value>) -> Value {
    match content {
        Some(Value::String(text)) => Value::String(text.clone()),
        Some(Value::Array(parts)) => Value::Array(
            parts
                .iter()
                .map(|part| {
                    let record = part.as_object();
                    if record
                        .and_then(|record| record.get("type"))
                        .and_then(Value::as_str)
                        == Some("text")
                    {
                        input_text(string_or(record.and_then(|record| record.get("text")), ""))
                    } else {
                        part.clone()
                    }
                })
                .collect(),
        ),
        other => Value::String(js_string(other)),
    }
}

/// Translate a Chat Completions request into a Responses API request.
///
/// `store_enabled` is the connection's `openaiStoreEnabled`; `provider` its
/// internal provider id. `new_call_id` supplies ids for tool calls that have
/// none (`generate_tool_call_id` in production).
pub fn openai_to_responses_request(
    model: &Value,
    body: &Value,
    store_enabled: bool,
    provider: Option<&str>,
    new_call_id: &mut dyn FnMut() -> String,
) -> Value {
    let root = body.as_object().cloned().unwrap_or_default();
    let mut result = Map::new();
    result.insert("model".to_owned(), model.clone());
    result.insert("stream".to_owned(), json!(true));
    if !store_enabled {
        result.insert("store".to_owned(), json!(false));
    }
    let model_name = model
        .as_str()
        .or_else(|| root.get("model").and_then(Value::as_str))
        .unwrap_or("");

    let mut input: Vec<Value> = Vec::new();
    let mut has_system = false;
    let empty = Vec::new();
    let messages = root
        .get("messages")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    for message in messages {
        let Some(message) = message.as_object() else {
            continue;
        };
        let role = string_or(message.get("role"), "");
        let content = message.get("content");
        match role {
            "system" | "developer" => {
                if !has_system {
                    result.insert(
                        "instructions".to_owned(),
                        Value::String(build_instructions_text(content.unwrap_or(&Value::Null))),
                    );
                    has_system = true;
                } else {
                    // Mid-conversation reminders stay developer-role items.
                    input.push(json!({
                        "type": "message",
                        "role": "developer",
                        "content": build_text_parts(content.unwrap_or(&Value::Null)),
                        "status": "completed",
                    }));
                }
            }
            "user" => input.push(json!({
                "type": "message",
                "role": "user",
                "content": user_content(content),
                "status": "completed",
            })),
            "assistant" => assistant_items(message, provider, model_name, new_call_id, &mut input),
            "tool" => input.push(json!({
                "type": "function_call_output",
                "call_id": clamp_call_id(js_trim(string_or(message.get("tool_call_id"), ""))),
                "output": tool_output(content),
                "status": "completed",
            })),
            "function" => input.push(json!({
                "type": "function_call_output",
                "call_id": clamp_call_id(&format!("call_{}", js_trim(string_or(message.get("name"), "")))),
                "output": match content {
                    Some(Value::String(text)) => text.clone(),
                    other => js_string(other),
                },
                "status": "completed",
            })),
            _ => {}
        }
    }

    // Tool results whose call is gone (a compacted history) are dropped.
    let known: std::collections::HashSet<String> = input
        .iter()
        .filter(|item| item["type"] == "function_call")
        .filter_map(|item| {
            item["call_id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
        .collect();
    input.retain(|item| {
        if item["type"] == "function_call_output" {
            if let Some(id) = item["call_id"].as_str().filter(|id| !id.is_empty()) {
                return known.contains(id);
            }
        }
        true
    });
    if !has_system {
        result.insert("instructions".to_owned(), json!(""));
    }

    if let Some(Value::Array(tools)) = root.get("tools") {
        let converted: Vec<Value> = tools
            .iter()
            .map(|tool| {
                let record = tool.as_object();
                if record
                    .and_then(|record| record.get("type"))
                    .and_then(Value::as_str)
                    != Some("function")
                {
                    return tool.clone();
                }
                let function = record
                    .and_then(|record| record.get("function"))
                    .and_then(Value::as_object);
                let get = |name: &str| function.and_then(|function| function.get(name));
                let mut out = Map::new();
                out.insert("type".to_owned(), json!("function"));
                out.insert("name".to_owned(), json!(string_or(get("name"), "")));
                out.insert(
                    "description".to_owned(),
                    json!(string_or(get("description"), "")),
                );
                for key in ["parameters", "strict"] {
                    if let Some(value) = get(key) {
                        out.insert(key.to_owned(), value.clone());
                    }
                }
                Value::Object(out)
            })
            .collect();
        result.insert("tools".to_owned(), Value::Array(converted));
    }

    if let Some(choice) = root.get("tool_choice") {
        let function = choice
            .as_object()
            .filter(|choice| choice.get("type").and_then(Value::as_str) == Some("function"))
            .and_then(|choice| choice.get("function"))
            .filter(|function| truthy(function));
        match function {
            Some(function) => {
                let mut out = Map::new();
                out.insert("type".to_owned(), json!("function"));
                if let Some(name) = function.get("name") {
                    out.insert("name".to_owned(), name.clone());
                }
                result.insert("tool_choice".to_owned(), Value::Object(out));
            }
            None => {
                result.insert("tool_choice".to_owned(), choice.clone());
            }
        }
    }
    for key in [
        "previous_response_id",
        "prompt_cache_key",
        "session_id",
        "conversation_id",
    ] {
        if let Some(value) = root.get(key) {
            result.insert(key.to_owned(), value.clone());
        }
    }

    // OpenAI and Copilot reject a body with no input and no continuity field.
    if input.is_empty() {
        let continuity = |key: &str| {
            result
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
        };
        if !(continuity("previous_response_id") || continuity("conversation_id")) {
            input.push(json!({"type": "message", "role": "user", "content": [input_text("...")]}));
        }
    }
    result.insert("input".to_owned(), Value::Array(input));

    for key in ["service_tier", "temperature"] {
        if let Some(value) = root.get(key) {
            result.insert(key.to_owned(), value.clone());
        }
    }
    // The Responses API takes max_output_tokens only.
    if let Some(value) = ["max_output_tokens", "max_completion_tokens", "max_tokens"]
        .iter()
        .find_map(|key| root.get(*key))
    {
        result.insert("max_output_tokens".to_owned(), value.clone());
    }
    if let Some(value) = root.get("top_p") {
        result.insert("top_p".to_owned(), value.clone());
    }
    map_response_format(body, &mut result);
    if let Some(level) = root.get("verbosity").and_then(normalize_verbosity) {
        let mut text = result
            .get("text")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        text.insert("verbosity".to_owned(), json!(level));
        result.insert("text".to_owned(), Value::Object(text));
    }

    let mut defaulted_summary = false;
    if let Some(reasoning) = root.get("reasoning") {
        result.insert("reasoning".to_owned(), reasoning.clone());
    } else if let Some(effort) = root.get("reasoning_effort") {
        let effort_model = if model.is_null() {
            root.get("model").unwrap_or(&Value::Null)
        } else {
            model
        };
        let effort = normalize_reasoning_effort(effort, effort_model);
        if !effort.is_empty() && effort != "none" {
            result.insert(
                "reasoning".to_owned(),
                json!({"effort": effort, "summary": REASONING_SUMMARY}),
            );
            defaulted_summary = true;
        } else if !effort.is_empty() {
            result.insert("reasoning".to_owned(), json!({"effort": effort}));
        }
    }
    if let Some(Value::Array(include)) = root.get("include") {
        if !include.is_empty() {
            result.insert("include".to_owned(), Value::Array(include.clone()));
        }
    }
    if defaulted_summary {
        let mut include = result
            .get("include")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !include.iter().any(|item| item == ENCRYPTED_CONTENT_INCLUDE) {
            include.push(json!(ENCRYPTED_CONTENT_INCLUDE));
        }
        result.insert("include".to_owned(), Value::Array(include));
    }
    if store_enabled {
        if let Some(value) = root
            .get(RESPONSES_STORE_MARKER)
            .or_else(|| root.get("store"))
        {
            result.insert("store".to_owned(), value.clone());
        }
    }
    Value::Object(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Requests the legacy translator produced for the same inputs
    /// (`responses_request_oracle.json`, generated with Node; generated call
    /// ids are pinned to `call_0_i`).
    #[test]
    fn translation_matches_the_legacy_translator() {
        let oracle: Vec<Value> =
            serde_json::from_str(include_str!("responses_request_oracle.json")).unwrap();
        assert!(oracle.len() >= 30, "{}", oracle.len());
        for case in &oracle {
            let mut generator = || "call_0_i".to_owned();
            let actual = openai_to_responses_request(
                &case["model"],
                &case["body"],
                case["store"].as_bool().unwrap_or(false),
                case["provider"].as_str(),
                &mut generator,
            );
            assert_eq!(actual, case["expected"], "{}", case["name"]);
        }
    }

    #[test]
    fn generated_ids_have_the_legacy_shape() {
        let id = generate_tool_call_id();
        let pattern = Regex::new(r"^call_[0-9a-z]+_[0-9a-z]{7}$").unwrap();
        assert!(pattern.is_match(&id), "{id}");
    }
}
