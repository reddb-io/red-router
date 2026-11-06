//! Incremental Anthropic SSE to OpenAI Chat Completions SSE conversion.
use axum::body::Bytes;
use futures_util::{stream, Stream, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io,
    pin::Pin,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_BUFFER: usize = 1024 * 1024;
type Source = Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>;

enum Block {
    Text,
    Tool { index: usize, arguments: String },
}

struct State {
    source: Source,
    buffer: Vec<u8>,
    data: String,
    pending: VecDeque<Bytes>,
    blocks: HashMap<u64, Block>,
    next_tool: usize,
    argument_bytes: usize,
    id: String,
    model: String,
    created: u64,
    input_tokens: u64,
    cache_read_tokens: Option<u64>,
    output_tokens: Option<u64>,
    include_usage: bool,
    started: bool,
    finished_reason: bool,
    done: bool,
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid or unsupported upstream stream",
    )
}

impl State {
    fn chunk(&mut self, delta: Value, finish: Option<&str>) {
        let value = json!({"id":self.id,"object":"chat.completion.chunk","created":self.created,"model":self.model,"choices":[{"index":0,"delta":delta,"finish_reason":finish}]});
        self.pending
            .push_back(Bytes::from(format!("data: {value}\n\n")));
    }

    fn event(&mut self, event: &Value) -> io::Result<()> {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        if self.done {
            return Err(invalid());
        }
        match kind {
            "ping" => {}
            "message_start" if !self.started => {
                let message = event.get("message").ok_or_else(invalid)?;
                self.id = message
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(invalid)?
                    .to_string();
                self.model = message
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(invalid)?
                    .to_string();
                let (prompt, cached) =
                    crate::translation::prompt_usage(message.get("usage").ok_or_else(invalid)?)
                        .map_err(|_| invalid())?;
                self.input_tokens = prompt;
                self.cache_read_tokens = cached;
                self.started = true;
                self.chunk(json!({"role":"assistant","content":""}), None);
            }
            "content_block_start" if self.started && !self.finished_reason => {
                let index = event
                    .get("index")
                    .and_then(Value::as_u64)
                    .ok_or_else(invalid)?;
                if self.blocks.len() >= 128 || self.blocks.contains_key(&index) {
                    return Err(invalid());
                }
                let block = event.get("content_block").ok_or_else(invalid)?;
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if block.get("citations").is_some_and(|v| !v.is_null()) {
                            return Err(invalid());
                        }
                        let text = block
                            .get("text")
                            .and_then(Value::as_str)
                            .ok_or_else(invalid)?;
                        self.blocks.insert(index, Block::Text);
                        if !text.is_empty() {
                            self.chunk(json!({"content":text}), None);
                        }
                    }
                    Some("tool_use") => {
                        if block.get("caller").is_some_and(|v| !v.is_null())
                            || block
                                .get("input")
                                .and_then(Value::as_object)
                                .is_none_or(|v| !v.is_empty())
                        {
                            return Err(invalid());
                        }
                        let id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .ok_or_else(invalid)?;
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .ok_or_else(invalid)?;
                        let tool = self.next_tool;
                        self.next_tool += 1;
                        self.blocks.insert(
                            index,
                            Block::Tool {
                                index: tool,
                                arguments: String::new(),
                            },
                        );
                        self.chunk(json!({"tool_calls":[{"index":tool,"id":id,"type":"function","function":{"name":name,"arguments":""}}]}), None);
                    }
                    _ => return Err(invalid()),
                }
            }
            "content_block_delta" if self.started && !self.finished_reason => {
                let index = event
                    .get("index")
                    .and_then(Value::as_u64)
                    .ok_or_else(invalid)?;
                let delta = event.get("delta").ok_or_else(invalid)?;
                match (
                    self.blocks.get_mut(&index),
                    delta.get("type").and_then(Value::as_str),
                ) {
                    (Some(Block::Text), Some("text_delta")) => {
                        let text = delta
                            .get("text")
                            .and_then(Value::as_str)
                            .ok_or_else(invalid)?;
                        if !text.is_empty() {
                            self.chunk(json!({"content":text}), None);
                        }
                    }
                    (
                        Some(Block::Tool {
                            index: tool,
                            arguments,
                        }),
                        Some("input_json_delta"),
                    ) => {
                        let fragment = delta
                            .get("partial_json")
                            .and_then(Value::as_str)
                            .ok_or_else(invalid)?;
                        if !fragment.is_empty() {
                            self.argument_bytes = self
                                .argument_bytes
                                .checked_add(fragment.len())
                                .filter(|bytes| *bytes <= MAX_BUFFER)
                                .ok_or_else(invalid)?;
                            arguments.push_str(fragment);
                            let tool = *tool;
                            self.chunk(json!({"tool_calls":[{"index":tool,"function":{"arguments":fragment}}]}), None);
                        }
                    }
                    _ => return Err(invalid()),
                }
            }
            "content_block_stop" if self.started && !self.finished_reason => {
                let index = event
                    .get("index")
                    .and_then(Value::as_u64)
                    .ok_or_else(invalid)?;
                match self.blocks.remove(&index).ok_or_else(invalid)? {
                    Block::Text => {}
                    Block::Tool { index, arguments } if arguments.is_empty() => {
                        self.chunk(
                            json!({"tool_calls":[{"index":index,"function":{"arguments":"{}"}}]}),
                            None,
                        );
                    }
                    Block::Tool { arguments, .. } => {
                        let parsed: Value =
                            serde_json::from_str(&arguments).map_err(|_| invalid())?;
                        if !parsed.is_object() {
                            return Err(invalid());
                        }
                    }
                }
            }
            "message_delta" if self.started && !self.finished_reason && self.blocks.is_empty() => {
                let reason = match event.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    Some("end_turn" | "stop_sequence") if self.next_tool == 0 => "stop",
                    Some("max_tokens") if self.next_tool == 0 => "length",
                    Some("tool_use") if self.next_tool > 0 => "tool_calls",
                    Some("refusal") if self.next_tool == 0 => "content_filter",
                    _ => return Err(invalid()),
                };
                self.output_tokens = event
                    .pointer("/usage/output_tokens")
                    .and_then(Value::as_u64);
                if self.include_usage && self.output_tokens.is_none() {
                    return Err(invalid());
                }
                self.finished_reason = true;
                self.chunk(json!({}), Some(reason));
            }
            "message_stop" if self.started && self.finished_reason => {
                if self.include_usage {
                    let completion = self.output_tokens.ok_or_else(invalid)?;
                    let total = self
                        .input_tokens
                        .checked_add(completion)
                        .ok_or_else(invalid)?;
                    let mut usage = json!({"prompt_tokens":self.input_tokens,"completion_tokens":completion,"total_tokens":total});
                    if let Some(cached) = self.cache_read_tokens {
                        usage["prompt_tokens_details"] = json!({"cached_tokens":cached});
                    }
                    let value = json!({"id":self.id,"object":"chat.completion.chunk","created":self.created,"model":self.model,"choices":[],"usage":usage});
                    self.pending
                        .push_back(Bytes::from(format!("data: {value}\n\n")));
                }
                self.pending
                    .push_back(Bytes::from_static(b"data: [DONE]\n\n"));
                self.done = true;
            }
            _ => return Err(invalid()),
        }
        Ok(())
    }
}

pub(crate) fn translate(
    response: reqwest::Response,
    include_usage: bool,
) -> impl Stream<Item = io::Result<Bytes>> {
    let state = State {
        source: response.bytes_stream().boxed(),
        buffer: Vec::new(),
        data: String::new(),
        pending: VecDeque::new(),
        blocks: HashMap::new(),
        next_tool: 0,
        argument_bytes: 0,
        id: String::new(),
        model: String::new(),
        created: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |time| time.as_secs()),
        input_tokens: 0,
        cache_read_tokens: None,
        output_tokens: None,
        include_usage,
        started: false,
        finished_reason: false,
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
                Some(Err(_)) => return Err(io::Error::other("upstream stream failed")),
                None => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "upstream stream ended before message_stop",
                    ))
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_tool_arguments_never_produce_a_completed_stream() {
        let mut state = State {
            source: stream::empty().boxed(),
            buffer: Vec::new(),
            data: String::new(),
            pending: VecDeque::new(),
            blocks: HashMap::new(),
            next_tool: 0,
            argument_bytes: 0,
            id: String::new(),
            model: String::new(),
            created: 0,
            input_tokens: 0,
            cache_read_tokens: None,
            output_tokens: None,
            include_usage: false,
            started: false,
            finished_reason: false,
            done: false,
        };
        state.event(&json!({"type":"message_start","message":{"id":"msg","model":"model","usage":{"input_tokens":1}}})).unwrap();
        state.event(&json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool","name":"f","input":{}}})).unwrap();
        state.event(&json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"x\":"}})).unwrap();
        assert!(state
            .event(&json!({"type":"content_block_stop","index":0}))
            .is_err());
        assert!(!state.done);
        assert!(!state
            .pending
            .iter()
            .any(|bytes| bytes.as_ref() == b"data: [DONE]\n\n"));
    }
}
