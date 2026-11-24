//! Deliberately bounded OpenAI Chat Completions to Anthropic Messages mapping.
//! Unsupported fields fail closed rather than being silently discarded.
use serde_json::{json, Map, Value};

fn object<'a>(value: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, ()> {
    let map = value.as_object().ok_or(())?;
    if map.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(());
    }
    Ok(map)
}

fn required_string<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str, ()> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(())
}

fn push_message(messages: &mut Vec<Value>, role: &str, mut blocks: Vec<Value>) {
    if let Some(last) = messages.last_mut().filter(|last| last["role"] == role) {
        last["content"]
            .as_array_mut()
            .expect("constructed content")
            .append(&mut blocks);
    } else {
        messages.push(json!({"role": role, "content": blocks}));
    }
}

pub(crate) fn request(input: &Value, model: &str) -> Result<Value, ()> {
    let source = object(
        input,
        &[
            "model",
            "messages",
            "max_tokens",
            "max_completion_tokens",
            "temperature",
            "top_p",
            "stream",
            "stream_options",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "stop",
        ],
    )?;
    let stream = match source.get("stream") {
        None => false,
        Some(value) => value.as_bool().ok_or(())?,
    };
    if let Some(options) = source.get("stream_options") {
        let options = object(options, &["include_usage"])?;
        if !stream
            || options
                .get("include_usage")
                .is_some_and(|value| !value.is_boolean())
        {
            return Err(());
        }
    }
    let max_tokens = match (
        source.get("max_tokens"),
        source.get("max_completion_tokens"),
    ) {
        (Some(_), Some(_)) => return Err(()),
        (Some(value), None) | (None, Some(value)) => {
            value.as_u64().filter(|value| *value > 0).ok_or(())?
        }
        (None, None) => 4096,
    };
    let mut system = Vec::new();
    let mut messages = Vec::new();
    for message in source.get("messages").and_then(Value::as_array).ok_or(())? {
        let message = object(message, &["role", "content", "tool_calls", "tool_call_id"])?;
        match required_string(message, "role")? {
            "system" | "developer" => {
                if !messages.is_empty()
                    || message.contains_key("tool_calls")
                    || message.contains_key("tool_call_id")
                {
                    return Err(());
                }
                system.push(json!({"type":"text","text":required_string(message, "content")?}));
            }
            "user" => {
                if message.contains_key("tool_calls") || message.contains_key("tool_call_id") {
                    return Err(());
                }
                push_message(
                    &mut messages,
                    "user",
                    vec![json!({"type":"text","text":required_string(message, "content")?})],
                );
            }
            "tool" => {
                if message.contains_key("tool_calls") {
                    return Err(());
                }
                let content = message.get("content").and_then(Value::as_str).ok_or(())?;
                push_message(
                    &mut messages,
                    "user",
                    vec![
                        json!({"type":"tool_result","tool_use_id":required_string(message, "tool_call_id")?,"content":content}),
                    ],
                );
            }
            "assistant" => {
                if message.contains_key("tool_call_id") {
                    return Err(());
                }
                let mut blocks = Vec::new();
                match message.get("content") {
                    Some(Value::String(text)) if !text.is_empty() => {
                        blocks.push(json!({"type":"text","text":text}))
                    }
                    Some(Value::String(_)) | Some(Value::Null) | None => {}
                    _ => return Err(()),
                }
                if let Some(calls) = message.get("tool_calls") {
                    for call in calls.as_array().ok_or(())? {
                        let call = object(call, &["id", "type", "function"])?;
                        if required_string(call, "type")? != "function" {
                            return Err(());
                        }
                        let function =
                            object(call.get("function").ok_or(())?, &["name", "arguments"])?;
                        let args: Value =
                            serde_json::from_str(required_string(function, "arguments")?)
                                .map_err(|_| ())?;
                        if !args.is_object() {
                            return Err(());
                        }
                        blocks.push(json!({"type":"tool_use","id":required_string(call, "id")?,"name":required_string(function, "name")?,"input":args}));
                    }
                }
                if blocks.is_empty() {
                    return Err(());
                }
                push_message(&mut messages, "assistant", blocks);
            }
            _ => return Err(()),
        }
    }
    if messages.is_empty() {
        return Err(());
    }
    let mut result = json!({"model":model,"messages":messages,"max_tokens":max_tokens});
    if stream {
        result["stream"] = json!(true);
    }
    if !system.is_empty() {
        result["system"] = json!(system);
    }
    for field in ["temperature", "top_p"] {
        if let Some(value) = source.get(field) {
            if !value.is_number() {
                return Err(());
            }
            result[field] = value.clone();
        }
    }
    if let Some(stop) = source.get("stop") {
        let stops = match stop {
            Value::String(value) => vec![value.clone()],
            Value::Array(values) => values
                .iter()
                .map(|value| value.as_str().map(str::to_owned).ok_or(()))
                .collect::<Result<Vec<_>, _>>()?,
            _ => return Err(()),
        };
        if stops.is_empty() || stops.iter().any(|value| value.is_empty()) {
            return Err(());
        }
        result["stop_sequences"] = json!(stops);
    }
    if let Some(tools) = source.get("tools") {
        let mut converted = Vec::new();
        for tool in tools.as_array().ok_or(())? {
            let tool = object(tool, &["type", "function"])?;
            if required_string(tool, "type")? != "function" {
                return Err(());
            }
            let function = object(
                tool.get("function").ok_or(())?,
                &["name", "description", "parameters", "strict"],
            )?;
            let parameters = function
                .get("parameters")
                .filter(|value| value.is_object())
                .ok_or(())?;
            let mut tool =
                json!({"name":required_string(function, "name")?,"input_schema":parameters});
            if let Some(value) = function.get("description") {
                if !value.is_string() {
                    return Err(());
                }
                tool["description"] = value.clone();
            }
            if let Some(value) = function.get("strict") {
                if !value.is_boolean() {
                    return Err(());
                }
                tool["strict"] = value.clone();
            }
            converted.push(tool);
        }
        if converted.is_empty() {
            return Err(());
        }
        result["tools"] = json!(converted);
    }
    if source.contains_key("tool_choice") || source.contains_key("parallel_tool_calls") {
        if !result["tools"].is_array() {
            return Err(());
        }
        let mut choice = match source.get("tool_choice") {
            None | Some(Value::String(_))
                if source
                    .get("tool_choice")
                    .is_none_or(|value| value == "auto") =>
            {
                json!({"type":"auto"})
            }
            Some(Value::String(value)) if value == "none" => json!({"type":"none"}),
            Some(Value::String(value)) if value == "required" => json!({"type":"any"}),
            Some(value) => {
                let choice = object(value, &["type", "function"])?;
                if required_string(choice, "type")? != "function" {
                    return Err(());
                }
                let function = object(choice.get("function").ok_or(())?, &["name"])?;
                json!({"type":"tool","name":required_string(function, "name")?})
            }
            _ => return Err(()),
        };
        if let Some(value) = source.get("parallel_tool_calls") {
            let parallel = value.as_bool().ok_or(())?;
            if choice["type"] == "none" && !parallel {
                return Err(());
            }
            if !parallel {
                choice["disable_parallel_tool_use"] = json!(true);
            }
        }
        result["tool_choice"] = choice;
    }
    Ok(result)
}

pub(crate) fn prompt_usage(usage: &Value) -> Result<(u64, Option<u64>), ()> {
    let input = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .ok_or(())?;
    let optional = |name| match usage.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or(()),
    };
    let cache_read = optional("cache_read_input_tokens")?;
    let cache_write = optional("cache_creation_input_tokens")?;
    let total = input
        .checked_add(cache_read.unwrap_or(0))
        .and_then(|value| value.checked_add(cache_write.unwrap_or(0)))
        .ok_or(())?;
    Ok((total, cache_read))
}

pub(crate) fn response(input: &Value) -> Result<Value, ()> {
    let id = input
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or(())?;
    let model = input
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
        .ok_or(())?;
    let mut content = String::new();
    let mut calls = Vec::new();
    for block in input.get("content").and_then(Value::as_array).ok_or(())? {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if block.get("citations").is_some_and(|value| !value.is_null()) {
                    return Err(());
                }
                content.push_str(block.get("text").and_then(Value::as_str).ok_or(())?);
            }
            Some("tool_use") => {
                if block.get("caller").is_some_and(|value| !value.is_null()) {
                    return Err(());
                }
                let id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or(())?;
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or(())?;
                let input = block
                    .get("input")
                    .filter(|value| value.is_object())
                    .ok_or(())?;
                calls.push(json!({"id":id,"type":"function","function":{"name":name,"arguments":serde_json::to_string(input).map_err(|_| ())?}}));
            }
            _ => return Err(()),
        }
    }
    let finish = match input.get("stop_reason").and_then(Value::as_str) {
        Some("end_turn" | "stop_sequence") if calls.is_empty() => "stop",
        Some("max_tokens") if calls.is_empty() => "length",
        Some("tool_use") if !calls.is_empty() => "tool_calls",
        Some("refusal") if calls.is_empty() => "content_filter",
        _ => return Err(()),
    };
    let usage = input.get("usage").ok_or(())?;
    let (prompt, cache_read) = prompt_usage(usage)?;
    let completion = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .ok_or(())?;
    let total = prompt.checked_add(completion).ok_or(())?;
    let mut message = json!({"role":"assistant","content": if content.is_empty() { Value::Null } else { Value::String(content) }});
    if !calls.is_empty() {
        message["tool_calls"] = json!(calls);
    }
    let mut usage =
        json!({"prompt_tokens":prompt,"completion_tokens":completion,"total_tokens":total});
    if let Some(cached) = cache_read {
        usage["prompt_tokens_details"] = json!({"cached_tokens":cached});
    }
    Ok(
        json!({"id":id,"object":"chat.completion","created":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| ())?.as_secs(),"model":model,"choices":[{"index":0,"message":message,"finish_reason":finish}],"usage":usage}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsupported_content_and_request_options() {
        let input = json!({"model":"alias","messages":[{"role":"user","content":"hello"}],"stream":"invalid"});
        assert!(request(&input, "target").is_err());
        let input =
            json!({"model":"alias","messages":[{"role":"user","content":[{"type":"image_url"}]}]});
        assert!(request(&input, "target").is_err());
        let output = json!({"id":"msg","model":"target","content":[{"type":"thinking","thinking":"private"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}});
        assert!(response(&output).is_err());
        let output = json!({"id":"msg","model":"target","content":[{"type":"text","text":"text","citations":[{}]}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}});
        assert!(response(&output).is_err());
    }

    #[test]
    fn cached_input_usage_is_accounted_for_without_overflow() {
        assert_eq!(
            prompt_usage(
                &json!({"input_tokens":7,"cache_read_input_tokens":3,"cache_creation_input_tokens":2})
            ),
            Ok((12, Some(3)))
        );
        assert_eq!(
            prompt_usage(&json!({"input_tokens":7,"cache_read_input_tokens":null})),
            Ok((7, None))
        );
        assert!(
            prompt_usage(&json!({"input_tokens":u64::MAX,"cache_read_input_tokens":1})).is_err()
        );
        assert!(prompt_usage(&json!({"input_tokens":1,"cache_read_input_tokens":"bad"})).is_err());
    }
}
