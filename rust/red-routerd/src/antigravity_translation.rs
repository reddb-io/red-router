//! Bounded OpenAI Chat Completions to Antigravity Cloud Code translation.
//!
//! The translator intentionally rejects fields and event shapes it cannot
//! preserve. Antigravity uploads are finite JSON, while responses are always
//! Cloud Code SSE even for a non-streaming OpenAI caller.
use crate::{
    accounting::ChatUsage, control_plane::ControlPlane, usage_stream::UsageContext,
    ProviderLoadGuard, HEADER_TIMEOUT,
};
use axum::body::{Body, Bytes};
use futures_util::{stream, Stream, StreamExt};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, VecDeque},
    io,
    pin::Pin,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, OwnedSemaphorePermit};

const MAX_BUFFER: usize = 2 * 1024 * 1024;
pub(crate) const MAX_TOOL_CALLS: usize = 128;
const SIGNATURE_BYPASS: &str = "skip_thought_signature_validator";
const DEFAULT_SYSTEM: &str = "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.\nYou are pair programming with a USER to solve their coding task.\n**Absolute paths only**\n**Proactiveness**";
type Source = Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>;

#[derive(Clone)]
pub(crate) struct SignatureContext {
    control: ControlPlane,
    provider_id: String,
}

impl SignatureContext {
    pub(crate) fn new(control: ControlPlane, provider_id: String) -> Self {
        Self {
            control,
            provider_id,
        }
    }

    pub(crate) fn control(&self) -> &ControlPlane {
        &self.control
    }

    pub(crate) fn provider_id(&self) -> &str {
        &self.provider_id
    }

    async fn store(&self, signatures: &[(String, String)]) -> Result<(), ()> {
        if signatures.is_empty() {
            return Ok(());
        }
        self.control
            .store_antigravity_thought_signatures(&self.provider_id, signatures)
            .await
            .map_err(|_| ())
    }
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid or unsupported Antigravity stream",
    )
}

fn frame_end(bytes: &[u8]) -> Option<usize> {
    let lf = bytes
        .windows(2)
        .position(|value| value == b"\n\n")
        .map(|at| at + 2);
    let crlf = bytes
        .windows(4)
        .position(|value| value == b"\r\n\r\n")
        .map(|at| at + 4);
    match (lf, crlf) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (left, right) => left.or(right),
    }
}

fn decode_frame(frame: &[u8]) -> Result<Value, ()> {
    let text = std::str::from_utf8(frame).map_err(|_| ())?;
    let mut data = String::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    if data.is_empty() || data.len() > MAX_BUFFER {
        return Err(());
    }
    serde_json::from_str(&data).map_err(|_| ())
}

fn object<'a>(value: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, ()> {
    let object = value.as_object().ok_or(())?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(());
    }
    Ok(object)
}

fn required_string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, ()> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(())
}

fn random_hex(bytes: usize) -> Result<String, ()> {
    let mut value = vec![0u8; bytes];
    getrandom::fill(&mut value).map_err(|_| ())?;
    Ok(hex::encode(value))
}

fn append_content(contents: &mut Vec<Value>, role: &str, mut parts: Vec<Value>) {
    if let Some(last) = contents.last_mut().filter(|last| last["role"] == role) {
        last["parts"]
            .as_array_mut()
            .expect("constructed Antigravity parts")
            .append(&mut parts);
    } else {
        contents.push(json!({"role":role,"parts":parts}));
    }
}

fn text_parts(value: &Value) -> Result<Vec<Value>, ()> {
    match value {
        Value::String(text) if !text.is_empty() => Ok(vec![json!({"text":text})]),
        Value::Array(items) if !items.is_empty() => items
            .iter()
            .map(|item| {
                let item = object(item, &["type", "text"])?;
                match required_string(item, "type")? {
                    "text" | "input_text" => Ok(json!({"text":required_string(item, "text")?})),
                    _ => Err(()),
                }
            })
            .collect(),
        _ => Err(()),
    }
}

fn generation_config(source: &Map<String, Value>) -> Result<Value, ()> {
    let mut config = Map::new();
    for (source_name, target_name) in [("temperature", "temperature"), ("top_p", "topP")] {
        if let Some(value) = source.get(source_name) {
            let value = value.as_f64().filter(|value| value.is_finite()).ok_or(())?;
            config.insert(target_name.to_owned(), json!(value));
        }
    }
    let maximum = match (
        source.get("max_tokens"),
        source.get("max_completion_tokens"),
    ) {
        (Some(_), Some(_)) => return Err(()),
        (Some(value), None) | (None, Some(value)) => Some(
            value
                .as_u64()
                .filter(|value| (1..=1_000_000).contains(value))
                .ok_or(())?,
        ),
        (None, None) => None,
    };
    if let Some(maximum) = maximum {
        config.insert("maxOutputTokens".to_owned(), json!(maximum));
    }
    if let Some(stop) = source.get("stop") {
        let stops = match stop {
            Value::String(value) if !value.is_empty() => vec![value.clone()],
            Value::Array(values) if !values.is_empty() => values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                        .ok_or(())
                })
                .collect::<Result<Vec<_>, _>>()?,
            _ => return Err(()),
        };
        config.insert("stopSequences".to_owned(), json!(stops));
    }
    Ok(Value::Object(config))
}

fn tools(source: &Map<String, Value>) -> Result<Option<Value>, ()> {
    let Some(tools) = source.get("tools") else {
        if source.contains_key("tool_choice") || source.contains_key("parallel_tool_calls") {
            return Err(());
        }
        return Ok(None);
    };
    let tools = tools
        .as_array()
        .filter(|tools| !tools.is_empty())
        .ok_or(())?;
    let mut declarations = Vec::with_capacity(tools.len());
    for tool in tools {
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
        let mut declaration =
            json!({"name":required_string(function, "name")?,"parameters":parameters});
        if let Some(description) = function.get("description") {
            if !description.is_string() {
                return Err(());
            }
            declaration["description"] = description.clone();
        }
        if function
            .get("strict")
            .is_some_and(|strict| !strict.is_boolean())
        {
            return Err(());
        }
        declarations.push(declaration);
    }
    Ok(Some(json!([{"functionDeclarations":declarations}])))
}

fn tool_config(source: &Map<String, Value>) -> Result<Option<Value>, ()> {
    let Some(choice) = source.get("tool_choice") else {
        if source
            .get("parallel_tool_calls")
            .is_some_and(|value| !value.is_boolean())
        {
            return Err(());
        }
        return Ok(None);
    };
    let config = match choice {
        Value::String(value) if value == "auto" => json!({"mode":"AUTO"}),
        Value::String(value) if value == "none" => json!({"mode":"NONE"}),
        Value::String(value) if value == "required" => json!({"mode":"ANY"}),
        Value::Object(_) => {
            let choice = object(choice, &["type", "function"])?;
            if required_string(choice, "type")? != "function" {
                return Err(());
            }
            let function = object(choice.get("function").ok_or(())?, &["name"])?;
            json!({"mode":"ANY","allowedFunctionNames":[required_string(function, "name")?]})
        }
        _ => return Err(()),
    };
    if source
        .get("parallel_tool_calls")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(());
    }
    Ok(Some(json!({"functionCallingConfig":config})))
}

pub(crate) fn historical_tool_call_ids(input: &Value) -> Result<Vec<String>, ()> {
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
    let messages = source.get("messages").and_then(Value::as_array).ok_or(())?;
    let mut ids = Vec::new();
    for message in messages {
        let Some(calls) = message.get("tool_calls") else {
            continue;
        };
        for call in calls.as_array().ok_or(())? {
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control))
                .ok_or(())?;
            if ids.len() >= MAX_TOOL_CALLS || ids.iter().any(|existing| existing == id) {
                return Err(());
            }
            ids.push(id.to_owned());
        }
    }
    Ok(ids)
}

pub(crate) fn request(
    input: &Value,
    model: &str,
    project: Option<&str>,
    signatures: Option<&HashMap<String, String>>,
) -> Result<Value, ()> {
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
    let messages = source.get("messages").and_then(Value::as_array).ok_or(())?;
    if messages.is_empty() {
        return Err(());
    }
    let mut contents = Vec::new();
    let mut system_parts = Vec::new();
    let mut call_names = HashMap::<String, String>::new();
    for message in messages {
        let message = object(message, &["role", "content", "tool_calls", "tool_call_id"])?;
        match required_string(message, "role")? {
            "system" | "developer" => {
                if !contents.is_empty()
                    || message.contains_key("tool_calls")
                    || message.contains_key("tool_call_id")
                {
                    return Err(());
                }
                system_parts.extend(text_parts(message.get("content").ok_or(())?)?);
            }
            "user" => {
                if message.contains_key("tool_calls") || message.contains_key("tool_call_id") {
                    return Err(());
                }
                append_content(
                    &mut contents,
                    "user",
                    text_parts(message.get("content").ok_or(())?)?,
                );
            }
            "assistant" => {
                if message.contains_key("tool_call_id") {
                    return Err(());
                }
                let mut parts = match message.get("content") {
                    Some(Value::Null) | None => Vec::new(),
                    Some(Value::String(value)) if value.is_empty() => Vec::new(),
                    Some(value) => text_parts(value)?,
                };
                if let Some(calls) = message.get("tool_calls") {
                    let calls = calls.as_array().ok_or(())?;
                    if calls.is_empty() || calls.len() > MAX_TOOL_CALLS {
                        return Err(());
                    }
                    for call in calls {
                        let call = object(call, &["id", "type", "function"])?;
                        if required_string(call, "type")? != "function" {
                            return Err(());
                        }
                        let id = required_string(call, "id")?;
                        if id.len() > 512 || id.chars().any(char::is_control) {
                            return Err(());
                        }
                        let function =
                            object(call.get("function").ok_or(())?, &["name", "arguments"])?;
                        let name = required_string(function, "name")?;
                        let arguments: Value =
                            serde_json::from_str(required_string(function, "arguments")?)
                                .map_err(|_| ())?;
                        if !arguments.is_object()
                            || call_names.insert(id.to_owned(), name.to_owned()).is_some()
                        {
                            return Err(());
                        }
                        let mut part = json!({"functionCall":{"name":name,"args":arguments}});
                        if let Some(signatures) = signatures {
                            let signature = signatures
                                .get(id)
                                .filter(|signature| {
                                    !signature.is_empty() && signature.len() <= 65_536
                                })
                                .map(String::as_str)
                                .unwrap_or(SIGNATURE_BYPASS);
                            part["thoughtSignature"] = Value::String(signature.to_owned());
                        }
                        parts.push(part);
                    }
                }
                if parts.is_empty() {
                    return Err(());
                }
                append_content(&mut contents, "model", parts);
            }
            "tool" => {
                if message.contains_key("tool_calls") {
                    return Err(());
                }
                let call_id = required_string(message, "tool_call_id")?;
                let name = call_names.get(call_id).ok_or(())?;
                let content = message.get("content").and_then(Value::as_str).ok_or(())?;
                append_content(
                    &mut contents,
                    "user",
                    vec![json!({"functionResponse":{"name":name,"response":{"result":content}}})],
                );
            }
            _ => return Err(()),
        }
    }
    if contents.is_empty() {
        return Err(());
    }
    if !system_parts.is_empty() {
        let first = contents.first_mut().ok_or(())?;
        if first["role"] != "user" {
            return Err(());
        }
        let first_parts = first["parts"].as_array_mut().ok_or(())?;
        system_parts.append(first_parts);
        *first_parts = system_parts;
    }
    if contents
        .last()
        .is_some_and(|content| content["role"] != "user")
    {
        contents.push(json!({"role":"user","parts":[{"text":"Continue."}]}));
    }
    let mut inner = json!({
        "contents":contents,
        "systemInstruction":{"role":"system","parts":[{"text":DEFAULT_SYSTEM}]},
        "generationConfig":generation_config(source)?,
    });
    if let Some(tools) = tools(source)? {
        inner["tools"] = tools;
        if let Some(config) = tool_config(source)? {
            inner["toolConfig"] = config;
        }
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ())?
        .as_millis();
    let request_id = format!("agent/{now}/{}", random_hex(4)?);
    let mut session_bytes = [0u8; 8];
    getrandom::fill(&mut session_bytes).map_err(|_| ())?;
    let session = u64::from_be_bytes(session_bytes) % 9_000_000_000_000_000_000u64;
    let mut request = json!({
        "sessionId":format!("-{session}"),
        "contents":inner["contents"].take(),
        "systemInstruction":inner["systemInstruction"].take(),
        "generationConfig":inner["generationConfig"].take(),
    });
    for field in ["tools", "toolConfig"] {
        if let Some(value) = inner.get_mut(field) {
            request[field] = value.take();
        }
    }
    Ok(json!({
        "project":project.unwrap_or(""),
        "requestId":request_id,
        "requestType":"agent",
        "userAgent":"antigravity",
        "model":model.rsplit('/').next().unwrap_or(model),
        "request":request
    }))
}

fn usage(metadata: &Value) -> Result<Value, ()> {
    let prompt = metadata
        .get("promptTokenCount")
        .and_then(Value::as_u64)
        .ok_or(())?;
    let completion = metadata
        .get("candidatesTokenCount")
        .and_then(Value::as_u64)
        .ok_or(())?;
    let total = metadata
        .get("totalTokenCount")
        .and_then(Value::as_u64)
        .or_else(|| prompt.checked_add(completion))
        .ok_or(())?;
    let mut result =
        json!({"prompt_tokens":prompt,"completion_tokens":completion,"total_tokens":total});
    if let Some(cached) = metadata.get("cachedContentTokenCount") {
        let cached = cached.as_u64().ok_or(())?;
        result["prompt_tokens_details"] = json!({"cached_tokens":cached});
    }
    if let Some(thoughts) = metadata.get("thoughtsTokenCount") {
        let thoughts = thoughts.as_u64().ok_or(())?;
        result["completion_tokens_details"] = json!({"reasoning_tokens":thoughts});
    }
    Ok(result)
}

fn finish_reason(value: &str, has_tools: bool) -> Result<&'static str, ()> {
    match value {
        "STOP" if has_tools => Ok("tool_calls"),
        "STOP" | "FINISH_REASON_UNSPECIFIED" => Ok("stop"),
        "MAX_TOKENS" => Ok("length"),
        "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" => Ok("content_filter"),
        _ => Err(()),
    }
}

pub(crate) struct CollectedResponse {
    pub(crate) value: Value,
    signatures: Vec<(String, String)>,
}

impl CollectedResponse {
    pub(crate) async fn persist(self, context: Option<&SignatureContext>) -> Result<Value, ()> {
        if let Some(context) = context {
            context.store(&self.signatures).await?;
        }
        Ok(self.value)
    }
}

fn part_signature(part: &Map<String, Value>) -> Result<Option<String>, ()> {
    part.get("thoughtSignature")
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty() && value.len() <= 65_536)
                .map(str::to_owned)
                .ok_or(())
        })
        .transpose()
}

pub(crate) fn response(bytes: &[u8], model: &str) -> Result<CollectedResponse, ()> {
    if bytes.is_empty() || bytes.len() > MAX_BUFFER {
        return Err(());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| ())?;
    let mut data = String::new();
    let mut events = Vec::new();
    for line in text.lines().chain(std::iter::once("")) {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            if !data.is_empty() {
                events.push(serde_json::from_str::<Value>(&data).map_err(|_| ())?);
                data.clear();
            }
        } else if let Some(value) = line.strip_prefix("data:") {
            let value = value.strip_prefix(' ').unwrap_or(value);
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value);
            if data.len() > MAX_BUFFER {
                return Err(());
            }
        }
    }
    if events.is_empty() {
        return Err(());
    }
    let mut id = format!("chatcmpl-agy-{}", random_hex(8)?);
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut calls = Vec::new();
    let mut signatures = Vec::new();
    let mut pending_signature = None;
    let call_prefix = random_hex(8)?;
    let mut finish = None;
    let mut final_usage = None;
    for event in events {
        let response = event.get("response").and_then(Value::as_object).ok_or(())?;
        if let Some(response_id) = response.get("responseId").and_then(Value::as_str) {
            if response_id.is_empty()
                || response_id.len() > 512
                || response_id.chars().any(char::is_control)
            {
                return Err(());
            }
            id = response_id.to_owned();
        }
        if let Some(candidates) = response.get("candidates") {
            let candidates = candidates.as_array().ok_or(())?;
            if candidates.len() > 1 {
                return Err(());
            }
            if let Some(candidate) = candidates.first() {
                let parts = candidate
                    .pointer("/content/parts")
                    .and_then(Value::as_array)
                    .ok_or(())?;
                for part in parts {
                    let part = part.as_object().ok_or(())?;
                    if let Some(signature) = part_signature(part)? {
                        pending_signature = Some(signature);
                    }
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        if part.get("thought").and_then(Value::as_bool) == Some(true) {
                            reasoning.push_str(text);
                        } else {
                            content.push_str(text);
                        }
                    } else if let Some(call) = part.get("functionCall") {
                        if calls.len() >= MAX_TOOL_CALLS {
                            return Err(());
                        }
                        let call = call.as_object().ok_or(())?;
                        let name = call
                            .get("name")
                            .and_then(Value::as_str)
                            .filter(|name| !name.is_empty())
                            .ok_or(())?;
                        let args = call.get("args").filter(|args| args.is_object()).ok_or(())?;
                        let index = calls.len();
                        let call_id = format!("call_agy_{call_prefix}_{index}");
                        if let Some(signature) =
                            part_signature(part)?.or_else(|| pending_signature.clone())
                        {
                            signatures.push((call_id.clone(), signature));
                        }
                        calls.push(json!({
                            "id":call_id,
                            "type":"function",
                            "function":{"name":name,"arguments":serde_json::to_string(args).map_err(|_| ())?}
                        }));
                    } else {
                        return Err(());
                    }
                }
                if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
                    if finish.is_some() {
                        return Err(());
                    }
                    finish = Some(finish_reason(reason, !calls.is_empty())?);
                }
            }
        }
        if let Some(metadata) = response.get("usageMetadata") {
            final_usage = Some(usage(metadata)?);
        }
    }
    let finish = finish.ok_or(())?;
    let usage = final_usage.ok_or(())?;
    let mut message = json!({
        "role":"assistant",
        "content":if content.is_empty() { Value::Null } else { Value::String(content) }
    });
    if !reasoning.is_empty() {
        message["reasoning_content"] = Value::String(reasoning);
    }
    if !calls.is_empty() {
        message["tool_calls"] = Value::Array(calls);
    }
    let created = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ())?
        .as_secs();
    Ok(CollectedResponse {
        value: json!({
            "id":id,
            "object":"chat.completion",
            "created":created,
            "model":model,
            "choices":[{"index":0,"message":message,"finish_reason":finish}],
            "usage":usage
        }),
        signatures,
    })
}

struct State {
    source: Source,
    buffer: Vec<u8>,
    data: String,
    pending: VecDeque<Bytes>,
    id: String,
    model: String,
    created: u64,
    next_tool: usize,
    call_prefix: String,
    pending_signature: Option<String>,
    signatures: Vec<(String, String)>,
    signature_context: Option<SignatureContext>,
    include_usage: bool,
    started: bool,
    finished: bool,
    done: bool,
}

impl State {
    fn chunk(&mut self, delta: Value, finish: Option<&str>) {
        let value = json!({"id":self.id,"object":"chat.completion.chunk","created":self.created,"model":self.model,"choices":[{"index":0,"delta":delta,"finish_reason":finish}]});
        self.pending
            .push_back(Bytes::from(format!("data: {value}\n\n")));
    }

    fn event(&mut self, event: &Value) -> io::Result<()> {
        if self.done || self.finished {
            return Err(invalid());
        }
        let response = event
            .get("response")
            .and_then(Value::as_object)
            .ok_or_else(invalid)?;
        if !self.started {
            if let Some(id) = response.get("responseId").and_then(Value::as_str) {
                if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
                    return Err(invalid());
                }
                self.id = id.to_owned();
            }
            self.started = true;
            self.chunk(json!({"role":"assistant","content":""}), None);
        }
        let mut has_tools = false;
        if let Some(candidates) = response.get("candidates") {
            let candidates = candidates.as_array().ok_or_else(invalid)?;
            if candidates.len() > 1 {
                return Err(invalid());
            }
            if let Some(candidate) = candidates.first() {
                let parts = candidate
                    .pointer("/content/parts")
                    .and_then(Value::as_array)
                    .ok_or_else(invalid)?;
                for part in parts {
                    let part = part.as_object().ok_or_else(invalid)?;
                    if let Some(signature) = part_signature(part).map_err(|_| invalid())? {
                        self.pending_signature = Some(signature);
                    }
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            if part.get("thought").and_then(Value::as_bool) == Some(true) {
                                self.chunk(json!({"reasoning_content":text}), None);
                            } else {
                                self.chunk(json!({"content":text}), None);
                            }
                        }
                    } else if let Some(call) = part.get("functionCall") {
                        let call = call.as_object().ok_or_else(invalid)?;
                        let name = call
                            .get("name")
                            .and_then(Value::as_str)
                            .filter(|name| !name.is_empty())
                            .ok_or_else(invalid)?;
                        let args = call
                            .get("args")
                            .filter(|args| args.is_object())
                            .ok_or_else(invalid)?;
                        if self.next_tool >= MAX_TOOL_CALLS {
                            return Err(invalid());
                        }
                        let index = self.next_tool;
                        self.next_tool += 1;
                        let id = format!("call_agy_{}_{index}", self.call_prefix);
                        if let Some(signature) = part_signature(part)
                            .map_err(|_| invalid())?
                            .or_else(|| self.pending_signature.clone())
                        {
                            self.signatures.push((id.clone(), signature));
                        }
                        let arguments = serde_json::to_string(args).map_err(|_| invalid())?;
                        self.chunk(json!({"tool_calls":[{"index":index,"id":id,"type":"function","function":{"name":name,"arguments":arguments}}]}), None);
                        has_tools = true;
                    } else {
                        return Err(invalid());
                    }
                }
                if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
                    let reason = finish_reason(reason, has_tools || self.next_tool > 0)
                        .map_err(|_| invalid())?;
                    self.finished = true;
                    self.chunk(json!({}), Some(reason));
                }
            }
        }
        if let Some(metadata) = response.get("usageMetadata") {
            if self.include_usage {
                let usage = usage(metadata).map_err(|_| invalid())?;
                let value = json!({"id":self.id,"object":"chat.completion.chunk","created":self.created,"model":self.model,"choices":[],"usage":usage});
                self.pending
                    .push_back(Bytes::from(format!("data: {value}\n\n")));
            }
        }
        if self.finished {
            self.pending
                .push_back(Bytes::from_static(b"data: [DONE]\n\n"));
            self.done = true;
        }
        Ok(())
    }

    async fn persist_signatures(&mut self) -> io::Result<()> {
        if self.signatures.is_empty() {
            return Ok(());
        }
        let signatures = std::mem::take(&mut self.signatures);
        let Some(context) = self.signature_context.as_ref() else {
            return Ok(());
        };
        context
            .store(&signatures)
            .await
            .map_err(|_| io::Error::other("Antigravity thought signature persistence unavailable"))
    }
}

pub(crate) fn translate(
    response: reqwest::Response,
    model: String,
    include_usage: bool,
    signature_context: Option<SignatureContext>,
) -> impl Stream<Item = io::Result<Bytes>> {
    let id = format!(
        "chatcmpl-agy-{}",
        random_hex(8).unwrap_or_else(|_| "unavailable".to_owned())
    );
    let state = State {
        source: response.bytes_stream().boxed(),
        buffer: Vec::new(),
        data: String::new(),
        pending: VecDeque::new(),
        id,
        model,
        created: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |time| time.as_secs()),
        next_tool: 0,
        call_prefix: random_hex(8).unwrap_or_else(|_| "unavailable".to_owned()),
        pending_signature: None,
        signatures: Vec::new(),
        signature_context,
        include_usage,
        started: false,
        finished: false,
        done: false,
    };
    stream::try_unfold(state, |mut state| async move {
        loop {
            if let Some(bytes) = state.pending.pop_front() {
                return Ok(Some((bytes, state)));
            }
            if state.done {
                return Ok(None);
            }
            if let Some(end) = state.buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = state.buffer.drain(..=end).collect();
                let line = &line[..line.len() - 1];
                let line = line.strip_suffix(b"\r").unwrap_or(line);
                let line = std::str::from_utf8(line).map_err(|_| invalid())?;
                if line.is_empty() {
                    if !state.data.is_empty() {
                        let event: Value =
                            serde_json::from_str(&state.data).map_err(|_| invalid())?;
                        state.data.clear();
                        state.event(&event)?;
                        state.persist_signatures().await?;
                    }
                } else if let Some(data) = line.strip_prefix("data:") {
                    let data = data.strip_prefix(' ').unwrap_or(data);
                    if !state.data.is_empty() {
                        state.data.push('\n');
                    }
                    state.data.push_str(data);
                    if state.data.len() > MAX_BUFFER {
                        return Err(invalid());
                    }
                }
                continue;
            }
            match state.source.next().await {
                Some(Ok(bytes)) => {
                    if state.buffer.len().saturating_add(bytes.len()) > MAX_BUFFER {
                        return Err(invalid());
                    }
                    state.buffer.extend_from_slice(&bytes);
                }
                Some(Err(_)) => return Err(io::Error::other("Antigravity stream failed")),
                None => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "Antigravity stream ended before a finish reason",
                    ))
                }
            }
        }
    })
}

/// Translate and settle an Antigravity stream while retaining the upstream
/// after a downstream disconnect. The final translated frame is published
/// only after durable quota settlement succeeds.
pub(crate) fn forward_accounted(
    response: reqwest::Response,
    model: String,
    include_usage: bool,
    usage_context: UsageContext,
    permits: (OwnedSemaphorePermit, Option<OwnedSemaphorePermit>),
    provider_load: Option<ProviderLoadGuard>,
    signature_context: Option<SignatureContext>,
) -> Body {
    let (sender, receiver) = mpsc::channel::<Result<Bytes, io::Error>>(8);
    tokio::spawn(async move {
        let _permits = permits;
        let _provider_load = provider_load;
        let mut usage_context = Some(usage_context);
        let mut source = response.bytes_stream();
        let mut pending = Vec::new();
        let mut connected = true;
        let mut complete = false;
        let mut state = State {
            source: stream::empty().boxed(),
            buffer: Vec::new(),
            data: String::new(),
            pending: VecDeque::new(),
            id: format!(
                "chatcmpl-agy-{}",
                random_hex(8).unwrap_or_else(|_| "unavailable".to_owned())
            ),
            model,
            created: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |time| time.as_secs()),
            next_tool: 0,
            call_prefix: random_hex(8).unwrap_or_else(|_| "unavailable".to_owned()),
            pending_signature: None,
            signatures: Vec::new(),
            signature_context,
            include_usage,
            started: false,
            finished: false,
            done: false,
        };
        'source: loop {
            let chunk = match tokio::time::timeout(HEADER_TIMEOUT, source.next()).await {
                Ok(Some(Ok(chunk))) => chunk,
                _ => break,
            };
            if pending.len().saturating_add(chunk.len()) > MAX_BUFFER {
                break;
            }
            pending.extend_from_slice(&chunk);
            while let Some(end) = frame_end(&pending) {
                if end > MAX_BUFFER {
                    break 'source;
                }
                let frame: Vec<u8> = pending.drain(..end).collect();
                let event = match decode_frame(&frame) {
                    Ok(event) => event,
                    Err(()) => break 'source,
                };
                let response = match event.get("response") {
                    Some(response) => response,
                    None => break 'source,
                };
                let terminal_usage = if response.get("usageMetadata").is_some()
                    && response
                        .get("candidates")
                        .and_then(Value::as_array)
                        .is_some_and(|candidates| {
                            !candidates.is_empty()
                                && candidates.iter().all(|candidate| {
                                    candidate
                                        .get("finishReason")
                                        .and_then(Value::as_str)
                                        .is_some_and(|reason| !reason.is_empty())
                                })
                        }) {
                    ChatUsage::from_gemini_response(response).ok()
                } else {
                    None
                };
                if state.event(&event).is_err() {
                    break 'source;
                }
                if state.persist_signatures().await.is_err() {
                    break 'source;
                }
                if let Some(usage) = terminal_usage {
                    let Some(context) = usage_context.take() else {
                        break 'source;
                    };
                    if context.record(&usage).await.is_err() {
                        break 'source;
                    }
                    complete = true;
                }
                while let Some(output) = state.pending.pop_front() {
                    if connected && sender.send(Ok(output)).await.is_err() {
                        connected = false;
                    }
                }
                if complete {
                    break 'source;
                }
            }
        }
        if !complete && connected {
            let _ = sender
                .send(Err(io::Error::other(
                    "Antigravity stream ended without recorded usage",
                )))
                .await;
        }
    });
    Body::from_stream(stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|item| (item, receiver))
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_maps_tools_and_preserves_project_boundary() {
        let signatures = HashMap::from([("call_1".to_owned(), "opaque-signature".to_owned())]);
        let request = request(
            &json!({
                "model":"alias",
                "messages":[
                    {"role":"system","content":"Be terse."},
                    {"role":"user","content":"weather"},
                    {"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\"city\":\"SP\"}"}}]},
                    {"role":"tool","tool_call_id":"call_1","content":"sunny"}
                ],
                "tools":[{"type":"function","function":{"name":"weather","description":"Weather","parameters":{"type":"object"}}}],
                "tool_choice":"auto",
                "stream":true,
                "stream_options":{"include_usage":true}
            }),
            "gemini-2.5-pro",
            Some("project-1"),
            Some(&signatures),
        )
        .unwrap();
        assert_eq!(request["project"], "project-1");
        assert_eq!(request["model"], "gemini-2.5-pro");
        assert_eq!(request["request"]["contents"][0]["role"], "user");
        assert_eq!(
            request["request"]["contents"][0]["parts"][0]["text"],
            "Be terse."
        );
        assert_eq!(
            request["request"]["contents"][1]["parts"][0]["functionCall"]["name"],
            "weather"
        );
        assert_eq!(
            request["request"]["contents"][1]["parts"][0]["thoughtSignature"],
            "opaque-signature"
        );
        assert_eq!(
            request["request"]["contents"][2]["parts"][0]["functionResponse"]["name"],
            "weather"
        );
    }

    #[test]
    fn request_rejects_options_that_would_be_silently_lost() {
        assert!(request(
            &json!({"model":"alias","messages":[{"role":"user","content":"hi"}],"n":2}),
            "gemini-2.5-pro",
            None,
            None,
        )
        .is_err());
        assert!(request(
            &json!({"model":"alias","messages":[{"role":"tool","tool_call_id":"missing","content":"value"}]}),
            "gemini-2.5-pro",
            None,
            None,
        )
        .is_err());
    }

    #[test]
    fn response_keeps_thought_signatures_server_side() {
        let event = json!({
            "response": {
                "responseId": "response-1",
                "candidates": [{
                    "content": {"parts": [{
                        "thoughtSignature": "opaque-upstream-signature",
                        "functionCall": {"name": "weather", "args": {"city": "SP"}}
                    }]},
                    "finishReason": "STOP"
                }],
                "usageMetadata": {
                    "promptTokenCount": 2,
                    "candidatesTokenCount": 3,
                    "totalTokenCount": 5
                }
            }
        });
        let bytes = format!("data: {event}\n\n");
        let collected = response(bytes.as_bytes(), "gemini-3-pro").unwrap();
        let call_id = collected.value["choices"][0]["message"]["tool_calls"][0]["id"]
            .as_str()
            .unwrap();
        assert!(call_id.starts_with("call_agy_"));
        assert!(!collected
            .value
            .to_string()
            .contains("opaque-upstream-signature"));
        assert_eq!(
            collected.signatures,
            vec![(call_id.to_owned(), "opaque-upstream-signature".to_owned())]
        );
    }
}
