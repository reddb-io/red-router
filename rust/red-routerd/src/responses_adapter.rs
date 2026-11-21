// Not wired into the handler yet (steps 3 to 5 of the OpenCode Go Responses plan in
// docs/architecture/RUSTIFY_HANDOFF.md); remove this allow when it is.
#![allow(dead_code)]

//! Adapts a Responses API event stream (what `OpenAiToResponses` targets answer,
//! always streamed, as the legacy request builder forces `stream: true`) to
//! Chat Completions, either as a chunk stream or folded into one JSON body.
//!
//! The per-event translation is `responses_stream::openai_responses_to_openai_response`;
//! this module only parses the SSE framing around it.

use crate::responses_stream::openai_responses_to_openai_response;
use crate::responses_stream_pure::UpstreamFailure;
use crate::responses_stream_state::ResponsesStreamState;
use axum::body::Bytes;
use futures_util::{stream, Stream, StreamExt};
use serde_json::{json, Map, Value};
use std::{
    collections::VecDeque,
    io,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_BUFFER: usize = 8 * 1024 * 1024;

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis())
}

/// Incremental server-sent-events parser: each completed `data:` block is one
/// JSON event. `[DONE]` markers are skipped.
#[derive(Default)]
struct SseEvents {
    buffer: Vec<u8>,
    data: String,
}

impl SseEvents {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, ()> {
        if self.buffer.len().saturating_add(bytes.len()) > MAX_BUFFER {
            return Err(());
        }
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            let line = &line[..line.len() - 1];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            let line = std::str::from_utf8(line).map_err(|_| ())?;
            if line.is_empty() {
                if let Some(event) = self.flush()? {
                    events.push(event);
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                let data = data.strip_prefix(' ').unwrap_or(data);
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(data);
                if self.data.len() > MAX_BUFFER {
                    return Err(());
                }
            }
        }
        Ok(events)
    }

    /// The event still pending when the source ends without a blank line.
    fn finish(&mut self) -> Result<Option<Event>, ()> {
        self.flush()
    }

    fn flush(&mut self) -> Result<Option<Event>, ()> {
        let data = std::mem::take(&mut self.data);
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return Ok(None);
        }
        serde_json::from_str(data).map(Some).map_err(|_| ())
    }
}

type Event = Value;

/// The failure the upstream reported inside the stream, if any.
fn failure(state: &ResponsesStreamState) -> Option<&UpstreamFailure> {
    state.upstream_error.as_ref()
}

struct Translator {
    state: ResponsesStreamState,
    clock: u128,
}

impl Translator {
    fn new() -> Self {
        Self {
            state: ResponsesStreamState::default(),
            clock: now_ms(),
        }
    }

    fn event(&mut self, event: &Event) -> Result<Vec<Value>, ()> {
        let chunks = openai_responses_to_openai_response(Some(event), &mut self.state, self.clock);
        if failure(&self.state).is_some() {
            return Err(());
        }
        Ok(chunks)
    }

    fn end(&mut self) -> Vec<Value> {
        openai_responses_to_openai_response(None, &mut self.state, self.clock)
    }
}

/// Fold a complete Responses event stream into one `chat.completion` body.
pub(crate) fn aggregate(bytes: &[u8]) -> Result<Value, ()> {
    let mut parser = SseEvents::default();
    let mut translator = Translator::new();
    let mut chunks = Vec::new();
    for event in parser.push(bytes)? {
        chunks.extend(translator.event(&event)?);
    }
    if let Some(event) = parser.finish()? {
        chunks.extend(translator.event(&event)?);
    }
    chunks.extend(translator.end());
    fold(chunks)
}

fn fold(chunks: Vec<Value>) -> Result<Value, ()> {
    let mut id = Value::Null;
    let mut created = Value::Null;
    let mut model = Value::Null;
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut finish_reason = Value::Null;
    let mut usage = Value::Null;
    let mut tool_calls: Vec<Map<String, Value>> = Vec::new();
    for chunk in &chunks {
        for (key, slot) in [
            ("id", &mut id),
            ("created", &mut created),
            ("model", &mut model),
        ] {
            if let Some(value) = chunk.get(key).filter(|value| !value.is_null()) {
                *slot = value.clone();
            }
        }
        if let Some(value) = chunk.get("usage").filter(|value| !value.is_null()) {
            usage = value.clone();
        }
        let Some(choice) = chunk.pointer("/choices/0") else {
            continue;
        };
        if let Some(reason) = choice.get("finish_reason").filter(|value| !value.is_null()) {
            finish_reason = reason.clone();
        }
        let Some(delta) = choice.get("delta") else {
            continue;
        };
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            content.push_str(text);
        }
        if let Some(text) = delta.get("reasoning_content").and_then(Value::as_str) {
            reasoning.push_str(text);
        }
        for call in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let index = call.get("index").and_then(Value::as_u64).ok_or(())? as usize;
            while tool_calls.len() <= index {
                tool_calls.push(Map::new());
            }
            let slot = &mut tool_calls[index];
            if let Some(call_id) = call.get("id").filter(|value| !value.is_null()) {
                slot.insert("id".to_owned(), call_id.clone());
                slot.insert("type".to_owned(), json!("function"));
            }
            if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                slot.entry("name").or_insert_with(|| json!(name));
            }
            if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str) {
                let joined = slot
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
                    + arguments;
                slot.insert("arguments".to_owned(), json!(joined));
            }
        }
    }
    if id.is_null() {
        return Err(());
    }
    let mut message = json!({"role":"assistant","content":if content.is_empty() && !tool_calls.is_empty() { Value::Null } else { json!(content) }});
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(
            tool_calls
                .into_iter()
                .map(|mut call| {
                    let name = call.remove("name").unwrap_or(Value::Null);
                    let arguments = call.remove("arguments").unwrap_or_else(|| json!(""));
                    call.insert(
                        "function".to_owned(),
                        json!({"name":name,"arguments":arguments}),
                    );
                    Value::Object(call)
                })
                .collect(),
        );
    }
    let mut body = json!({
        "id": id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{"index":0,"message":message,"finish_reason":finish_reason}]
    });
    if !usage.is_null() {
        body["usage"] = usage;
    }
    Ok(body)
}

struct StreamState {
    source: futures_util::stream::BoxStream<'static, reqwest::Result<Bytes>>,
    parser: SseEvents,
    translator: Translator,
    pending: VecDeque<Bytes>,
    ended: bool,
    done: bool,
}

fn frame(chunks: Vec<Value>, pending: &mut VecDeque<Bytes>) {
    for chunk in chunks {
        pending.push_back(Bytes::from(format!("data: {chunk}\n\n")));
    }
}

/// Translate a Responses event stream into Chat Completions SSE.
pub(crate) fn translate(response: reqwest::Response) -> impl Stream<Item = io::Result<Bytes>> {
    let state = StreamState {
        source: response.bytes_stream().boxed(),
        parser: SseEvents::default(),
        translator: Translator::new(),
        pending: VecDeque::new(),
        ended: false,
        done: false,
    };
    stream::try_unfold(state, |mut state| async move {
        let invalid = || io::Error::new(io::ErrorKind::InvalidData, "invalid Responses stream");
        loop {
            if let Some(bytes) = state.pending.pop_front() {
                return Ok(Some((bytes, state)));
            }
            if state.done {
                return Ok(None);
            }
            if state.ended {
                let chunks = state.translator.end();
                frame(chunks, &mut state.pending);
                state
                    .pending
                    .push_back(Bytes::from_static(b"data: [DONE]\n\n"));
                state.done = true;
                continue;
            }
            match state.source.next().await {
                Some(Ok(bytes)) => {
                    for event in state.parser.push(&bytes).map_err(|_| invalid())? {
                        let chunks = state.translator.event(&event).map_err(|_| invalid())?;
                        frame(chunks, &mut state.pending);
                    }
                }
                Some(Err(_)) => return Err(io::Error::other("upstream stream failed")),
                None => {
                    if let Some(event) = state.parser.finish().map_err(|_| invalid())? {
                        let chunks = state.translator.event(&event).map_err(|_| invalid())?;
                        frame(chunks, &mut state.pending);
                    }
                    state.ended = true;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sse(events: &[Value]) -> Vec<u8> {
        events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect::<String>()
            .into_bytes()
    }

    #[test]
    fn folds_a_text_stream_into_one_chat_completion() {
        let body = aggregate(&sse(&[
            json!({"type":"response.created","response":{"model":"gpt-x"}}),
            json!({"type":"response.output_text.delta","delta":"Hel"}),
            json!({"type":"response.output_text.delta","delta":"lo"}),
            json!({"type":"response.completed","response":{"model":"gpt-x","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}),
        ]))
        .unwrap();
        assert_eq!(body["object"], "chat.completion");
        assert_eq!(body["choices"][0]["message"]["content"], "Hello");
        assert_eq!(body["choices"][0]["finish_reason"], "stop");
        assert_eq!(body["usage"]["prompt_tokens"], 3);
        assert_eq!(body["usage"]["completion_tokens"], 2);
    }

    #[test]
    fn a_failed_response_is_an_error() {
        assert!(aggregate(&sse(&[
            json!({"type":"response.output_text.delta","delta":"x"}),
            json!({"type":"response.failed","response":{"error":{"message":"boom"}}}),
        ]))
        .is_err());
    }

    #[test]
    fn parses_events_split_across_reads() {
        let mut parser = SseEvents::default();
        assert!(parser.push(b"data: {\"type\":\"a\"").unwrap().is_empty());
        let events = parser.push(b"}\n\ndata: [DONE]\n\n").unwrap();
        assert_eq!(events, vec![json!({"type":"a"})]);
    }
}
