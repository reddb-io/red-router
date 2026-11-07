//! Forward OpenAI SSE while draining the provider after client disconnect.
use crate::{
    accounting::{ChatUsage, TokenPrices},
    product::ProductConnection,
    ProviderLoadGuard,
};
use axum::body::{Body, Bytes};
use futures_util::{stream, StreamExt};
use std::io;
use tokio::sync::{mpsc, OwnedSemaphorePermit};

const MAX_FRAME: usize = 1_048_576;

pub(crate) struct UsageContext {
    pub(crate) connection: ProductConnection,
    pub(crate) event_id: String,
    pub(crate) key: String,
    pub(crate) model: String,
    pub(crate) prices: TokenPrices,
}

enum Event {
    Ordinary,
    Usage(ChatUsage),
    Done,
}

fn classify(frame: &[u8]) -> Result<Event, ()> {
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
/// forwards [DONE] only after successfully recording usage in SQLite.
pub(crate) fn forward(
    response: reqwest::Response,
    usage: UsageContext,
    permits: (OwnedSemaphorePermit, Option<OwnedSemaphorePermit>),
    provider_load: Option<ProviderLoadGuard>,
) -> Body {
    let (sender, receiver) = mpsc::channel::<Result<Bytes, io::Error>>(8);
    tokio::spawn(async move {
        let UsageContext {
            connection,
            event_id,
            key,
            model,
            prices,
        } = usage;
        let _permits = permits;
        let _provider_load = provider_load;
        let mut source = response.bytes_stream();
        let mut pending = Vec::<u8>::new();
        let mut usage = None;
        let mut connected = true;
        let mut complete = false;
        let mut done_seen = false;
        while let Ok(Some(next)) = tokio::time::timeout(crate::HEADER_TIMEOUT, source.next()).await
        {
            let Ok(chunk) = next else { break };
            pending.extend_from_slice(&chunk);
            while let Some(end) = frame_end(&pending) {
                if end > MAX_FRAME {
                    break;
                }
                let frame: Vec<u8> = pending.drain(..end).collect();
                match classify(&frame) {
                    Ok(Event::Usage(found)) => {
                        if usage.as_ref().is_some_and(|existing| existing != &found) {
                            pending.resize(MAX_FRAME + 1, 0);
                            break;
                        }
                        usage = Some(found);
                    }
                    Ok(Event::Done) => {
                        done_seen = true;
                        if let Some(usage) = usage.take() {
                            if connection
                                .record_usage(&event_id, &key, &model, &usage, &prices)
                                .await
                                .is_ok()
                            {
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
                if connected && sender.send(Ok(Bytes::from(frame))).await.is_err() {
                    connected = false;
                }
            }
            if done_seen || pending.len() > MAX_FRAME {
                break;
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
        assert!(matches!(classify(b"data: [DONE]\n\n"), Ok(Event::Done)));
        assert!(matches!(
            classify(b"data: {\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3}}\n\n"),
            Ok(Event::Usage(_))
        ));
        assert!(classify(b"data: {\"usage\":{}}\n\n").is_err());
    }
}
