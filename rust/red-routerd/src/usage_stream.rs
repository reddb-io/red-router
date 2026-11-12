//! Forward accounted SSE while draining the provider after client disconnect.
use crate::{
    accounting::{ChatUsage, TokenPrices},
    product::ProductConnection,
    ProviderLoadGuard, ProviderProtocol,
};
use axum::body::{Body, Bytes};
use futures_util::{stream, StreamExt};
use std::io;
use tokio::sync::{mpsc, OwnedSemaphorePermit};

const MAX_FRAME: usize = 1_048_576;

pub(crate) enum UsageContext {
    Product {
        connection: ProductConnection,
        event_id: String,
        key: String,
        model: String,
        prices: Option<TokenPrices>,
        usage_attributes: crate::accounting::UsageAttributes,
    },
    Native {
        control: crate::control_plane::ControlPlane,
        identity: crate::policy::ClientIdentity,
        attribution: crate::native_usage::UsageAttribution,
        provider: String,
        model: String,
        prices: Option<TokenPrices>,
        event_id: String,
    },
}

impl UsageContext {
    pub(crate) async fn record(self, usage: &ChatUsage) -> Result<(), &'static str> {
        match self {
            Self::Product {
                connection,
                event_id,
                key,
                model,
                prices,
                usage_attributes,
            } => {
                connection
                    .record_usage(
                        &event_id,
                        &key,
                        &model,
                        usage,
                        prices.as_ref(),
                        &usage_attributes,
                    )
                    .await
            }
            Self::Native {
                control,
                identity,
                attribution,
                provider,
                model,
                prices,
                event_id,
            } => {
                control
                    .record_native_usage(
                        &event_id,
                        &identity,
                        &provider,
                        &model,
                        usage,
                        prices.as_ref(),
                        &attribution,
                    )
                    .await
            }
        }
    }
}

enum Event {
    Ordinary,
    Usage(ChatUsage),
    Complete(ChatUsage),
    /// Gemini has no separate terminal SSE marker. Hold the usage-bearing
    /// response until the provider closes the stream, then settle before the
    /// client observes that final response.
    HoldComplete(ChatUsage),
    Done,
}

#[derive(Default)]
struct AnthropicUsageState {
    input: Option<u64>,
    output: Option<u64>,
    cache_read: u64,
    cache_creation: u64,
    saw_delta: bool,
    complete: bool,
}

struct UsageParser {
    protocol: ProviderProtocol,
    anthropic: AnthropicUsageState,
    gemini_complete: bool,
}

impl UsageParser {
    fn new(protocol: ProviderProtocol) -> Self {
        Self {
            protocol,
            anthropic: AnthropicUsageState::default(),
            gemini_complete: false,
        }
    }

    fn classify(&mut self, frame: &[u8]) -> Result<Event, ()> {
        classify(frame, self)
    }
}

fn classify(frame: &[u8], parser: &mut UsageParser) -> Result<Event, ()> {
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
    if data == "[DONE]" {
        return Ok(Event::Done);
    }
    if data.is_empty() {
        return Ok(Event::Ordinary);
    }
    let value: serde_json::Value = serde_json::from_str(&data).map_err(|_| ())?;
    match parser.protocol {
        ProviderProtocol::OpenAi => {
            if value
                .get("service_tier")
                .is_some_and(|tier| !tier.is_null() && tier.as_str() != Some("default"))
            {
                return Err(());
            }
            if value.get("usage").is_some_and(|v| !v.is_null()) {
                Ok(Event::Usage(
                    ChatUsage::from_response(&value).map_err(|_| ())?,
                ))
            } else {
                Ok(Event::Ordinary)
            }
        }
        ProviderProtocol::OpenAiResponses => match value.get("type").and_then(|v| v.as_str()) {
            Some("response.completed") => {
                let response = value.get("response").ok_or(())?;
                if response
                    .get("service_tier")
                    .is_some_and(|tier| !tier.is_null() && tier.as_str() != Some("default"))
                {
                    return Err(());
                }
                Ok(Event::Complete(
                    ChatUsage::from_responses_response(response).map_err(|_| ())?,
                ))
            }
            Some("response.failed" | "response.incomplete" | "error") => Err(()),
            _ => Ok(Event::Ordinary),
        },
        ProviderProtocol::Anthropic => anthropic_event(&value, &mut parser.anthropic),
        ProviderProtocol::Gemini => gemini_event(&value, &mut parser.gemini_complete),
        ProviderProtocol::Antigravity => gemini_event(
            value.get("response").unwrap_or(&value),
            &mut parser.gemini_complete,
        ),
        _ => Err(()),
    }
}

fn required_u64(value: &serde_json::Value, pointer: &str) -> Result<u64, ()> {
    value
        .pointer(pointer)
        .and_then(serde_json::Value::as_u64)
        .ok_or(())
}

fn optional_u64(value: &serde_json::Value, pointer: &str) -> Result<u64, ()> {
    match value.pointer(pointer) {
        None | Some(serde_json::Value::Null) => Ok(0),
        Some(value) => value.as_u64().ok_or(()),
    }
}

fn anthropic_event(
    value: &serde_json::Value,
    state: &mut AnthropicUsageState,
) -> Result<Event, ()> {
    let kind = value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or(())?;
    if state.complete || kind == "error" {
        return Err(());
    }
    match kind {
        "message_start" if state.input.is_none() && !state.saw_delta => {
            let ordinary = required_u64(value, "/message/usage/input_tokens")?;
            state.cache_read = optional_u64(value, "/message/usage/cache_read_input_tokens")?;
            state.cache_creation =
                optional_u64(value, "/message/usage/cache_creation_input_tokens")?;
            state.input = Some(
                ordinary
                    .checked_add(state.cache_read)
                    .and_then(|tokens| tokens.checked_add(state.cache_creation))
                    .ok_or(())?,
            );
            Ok(Event::Ordinary)
        }
        "message_delta" if state.input.is_some() && !state.saw_delta => {
            if value
                .pointer("/delta/stop_reason")
                .and_then(serde_json::Value::as_str)
                .is_none()
            {
                return Err(());
            }
            state.output = Some(required_u64(value, "/usage/output_tokens")?);
            state.saw_delta = true;
            Ok(Event::Ordinary)
        }
        "message_stop" if state.input.is_some() && state.saw_delta => {
            let usage = ChatUsage {
                input: state.input.ok_or(())?,
                output: state.output.ok_or(())?,
                reasoning: 0,
                cache_read: state.cache_read,
                cache_creation: state.cache_creation,
            };
            usage.billable_tokens().map_err(|_| ())?;
            state.complete = true;
            Ok(Event::Complete(usage))
        }
        "ping" => Ok(Event::Ordinary),
        "content_block_start" | "content_block_delta" | "content_block_stop"
            if state.input.is_some() && !state.complete =>
        {
            Ok(Event::Ordinary)
        }
        _ => Err(()),
    }
}

fn gemini_event(value: &serde_json::Value, complete: &mut bool) -> Result<Event, ()> {
    if *complete || value.get("error").is_some() {
        return Err(());
    }
    if value.get("usageMetadata").is_none() {
        return Ok(Event::Ordinary);
    }
    let candidates_complete = value
        .get("candidates")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|candidates| {
            !candidates.is_empty()
                && candidates.iter().all(|candidate| {
                    candidate
                        .get("finishReason")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|reason| !reason.is_empty())
                })
        });
    let prompt_blocked = value
        .pointer("/promptFeedback/blockReason")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|reason| !reason.is_empty());
    if !candidates_complete && !prompt_blocked {
        return Err(());
    }
    let usage = ChatUsage::from_gemini_response(value).map_err(|_| ())?;
    *complete = true;
    Ok(Event::HoldComplete(usage))
}

fn frame_end(bytes: &[u8]) -> Option<usize> {
    let lf = bytes.windows(2).position(|w| w == b"\n\n").map(|n| n + 2);
    let crlf = bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|n| n + 4);
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// The spawned task owns the upstream even if the client drops its body. It
/// forwards the protocol's terminal success event only after recording usage.
pub(crate) fn forward(
    response: reqwest::Response,
    protocol: ProviderProtocol,
    usage: UsageContext,
    permits: (OwnedSemaphorePermit, Option<OwnedSemaphorePermit>),
    provider_load: Option<ProviderLoadGuard>,
) -> Body {
    let (sender, receiver) = mpsc::channel::<Result<Bytes, io::Error>>(8);
    tokio::spawn(async move {
        let mut usage_context = Some(usage);
        let _permits = permits;
        let _provider_load = provider_load;
        let mut source = response.bytes_stream();
        let mut pending = Vec::<u8>::new();
        let mut usage = None;
        let mut held_complete = None;
        let mut connected = true;
        let mut complete = false;
        let mut done_seen = false;
        let mut clean_eof = false;
        let mut parser = UsageParser::new(protocol);
        loop {
            let chunk = match tokio::time::timeout(crate::HEADER_TIMEOUT, source.next()).await {
                Ok(Some(Ok(chunk))) => chunk,
                Ok(None) => {
                    clean_eof = true;
                    break;
                }
                _ => break,
            };
            pending.extend_from_slice(&chunk);
            while let Some(end) = frame_end(&pending) {
                if end > MAX_FRAME {
                    break;
                }
                let frame: Vec<u8> = pending.drain(..end).collect();
                let mut forward = true;
                match parser.classify(&frame) {
                    Ok(Event::Usage(found)) => {
                        if usage.as_ref().is_some_and(|existing| existing != &found) {
                            pending.resize(MAX_FRAME + 1, 0);
                            break;
                        }
                        usage = Some(found);
                    }
                    Ok(Event::Complete(found)) => {
                        done_seen = true;
                        let Some(context) = usage_context.take() else {
                            break;
                        };
                        if context.record(&found).await.is_ok() {
                            complete = true;
                            if connected {
                                let _ = sender.send(Ok(Bytes::from(frame))).await;
                            }
                        }
                        break;
                    }
                    Ok(Event::HoldComplete(found)) => {
                        if held_complete.is_some() {
                            pending.resize(MAX_FRAME + 1, 0);
                            break;
                        }
                        held_complete = Some((frame.clone(), found));
                        forward = false;
                    }
                    Ok(Event::Done) => {
                        done_seen = true;
                        if let Some(usage) = usage.take() {
                            let Some(context) = usage_context.take() else {
                                break;
                            };
                            if context.record(&usage).await.is_ok() {
                                complete = true;
                                if connected {
                                    let _ = sender.send(Ok(Bytes::from(frame))).await;
                                }
                            }
                        }
                        break;
                    }
                    Ok(Event::Ordinary) => {}
                    Err(()) => {
                        pending.resize(MAX_FRAME + 1, 0);
                        break;
                    }
                }
                if forward && connected && sender.send(Ok(Bytes::from(frame))).await.is_err() {
                    connected = false;
                }
            }
            if done_seen || pending.len() > MAX_FRAME {
                break;
            }
        }
        if !complete && clean_eof && pending.is_empty() {
            if let Some((frame, found)) = held_complete.take() {
                if let Some(context) = usage_context.take() {
                    if context.record(&found).await.is_ok() {
                        complete = true;
                        if connected {
                            let _ = sender.send(Ok(Bytes::from(frame))).await;
                        }
                    }
                }
            }
        }
        if !complete && connected {
            let _ = sender
                .send(Err(io::Error::other(
                    "provider stream ended without recorded usage",
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
    fn parses_fragmented_boundaries_and_usage() {
        assert_eq!(frame_end(b"data: {}\r\n\r\ndata: x\n\n"), Some(12));
        let mut openai = UsageParser::new(ProviderProtocol::OpenAi);
        assert!(matches!(
            openai.classify(b"data: [DONE]\n\n"),
            Ok(Event::Done)
        ));
        let mut openai = UsageParser::new(ProviderProtocol::OpenAi);
        assert!(matches!(
            openai.classify(b"data: {\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3}}\n\n"),
            Ok(Event::Usage(_))
        ));
        let mut openai = UsageParser::new(ProviderProtocol::OpenAi);
        assert!(openai.classify(b"data: {\"usage\":{}}\n\n").is_err());
        let mut responses = UsageParser::new(ProviderProtocol::OpenAiResponses);
        assert!(matches!(
            responses.classify(
                b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n"
            ),
            Ok(Event::Complete(_))
        ));
        let mut responses = UsageParser::new(ProviderProtocol::OpenAiResponses);
        assert!(responses
            .classify(
                b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":null}}\n\n"
            )
            .is_err());
    }

    #[test]
    fn assembles_anthropic_usage_only_at_message_stop() {
        let mut parser = UsageParser::new(ProviderProtocol::Anthropic);
        assert!(matches!(
            parser.classify(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3,\"cache_read_input_tokens\":1,\"cache_creation_input_tokens\":2}}}\n\n"),
            Ok(Event::Ordinary)
        ));
        assert!(matches!(
            parser.classify(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\n"),
            Ok(Event::Ordinary)
        ));
        match parser.classify(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n") {
            Ok(Event::Complete(usage)) => assert_eq!(
                usage,
                ChatUsage {
                    input: 6,
                    output: 4,
                    reasoning: 0,
                    cache_read: 1,
                    cache_creation: 2,
                }
            ),
            _ => panic!("expected completed Anthropic usage"),
        }
        assert!(parser
            .classify(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
            .is_err());
    }

    #[test]
    fn holds_terminal_gemini_usage_until_eof() {
        let mut parser = UsageParser::new(ProviderProtocol::Gemini);
        assert!(matches!(
            parser.classify(
                b"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]}}]}\n\n"
            ),
            Ok(Event::Ordinary)
        ));
        match parser.classify(b"data: {\"candidates\":[{\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":2,\"candidatesTokenCount\":3,\"thoughtsTokenCount\":1,\"totalTokenCount\":6}}\n\n") {
            Ok(Event::HoldComplete(usage)) => assert_eq!(
                usage,
                ChatUsage {
                    input: 2,
                    output: 4,
                    reasoning: 1,
                    cache_read: 0,
                    cache_creation: 0,
                }
            ),
            _ => panic!("expected held Gemini usage"),
        }
    }
}
