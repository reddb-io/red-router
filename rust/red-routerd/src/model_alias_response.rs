//! Bounded response-only model-name rewriting. Accounting sees upstream identity.
use axum::{
    body::{Body, Bytes},
    http::{header, StatusCode},
    response::Response,
};
use futures_util::StreamExt;
use serde_json::Value;
use std::io;
const MAX_FRAME: usize = 1024 * 1024;
fn replace_model(value: &mut Value, alias: &str) {
    for pointer in ["/model", "/message/model", "/response/model"] {
        if let Some(model) = value.pointer_mut(pointer).filter(|value| value.is_string()) {
            *model = Value::String(alias.to_owned());
        }
    }
}
fn frame(raw: &[u8], alias: &str) -> Result<Vec<u8>, io::Error> {
    let text =
        std::str::from_utf8(raw).map_err(|_| io::Error::other("Invalid alias response event"))?;
    let data: Vec<_> = text
        .lines()
        .filter_map(|line| {
            line.strip_prefix("data:")
                .map(|data| data.strip_prefix(' ').unwrap_or(data))
        })
        .collect();
    if data.is_empty() || data.join("\n").trim() == "[DONE]" {
        return Ok(raw.to_vec());
    }
    let Ok(mut value) = serde_json::from_str::<Value>(&data.join("\n")) else {
        return Ok(raw.to_vec());
    };
    replace_model(&mut value, alias);
    let encoded = serde_json::to_string(&value).map_err(io::Error::other)?;
    let mut output = String::new();
    let mut written = false;
    for line in text.lines() {
        if line.starts_with("data:") {
            if !written {
                output.push_str("data: ");
                output.push_str(&encoded);
                output.push('\n');
                written = true;
            }
        } else if !line.is_empty() {
            output.push_str(line);
            output.push('\n');
        }
    }
    output.push('\n');
    Ok(output.into_bytes())
}
#[derive(Default)]
struct Frames {
    pending: Vec<u8>,
    failed: bool,
}
impl Frames {
    fn push(&mut self, bytes: &[u8], alias: &str) -> Result<Bytes, io::Error> {
        if self.failed {
            return Err(io::Error::other("Alias response stream is invalid"));
        }
        let mut output = Vec::new();
        for byte in bytes {
            self.pending.push(*byte);
            if self.pending.len() > MAX_FRAME {
                self.failed = true;
                return Err(io::Error::other("Alias response event is too large"));
            }
            if self.pending.ends_with(b"\n\n") || self.pending.ends_with(b"\r\n\r\n") {
                output.extend(frame(&self.pending, alias)?);
                self.pending.clear();
            }
        }
        Ok(Bytes::from(output))
    }
}
pub(crate) async fn rewrite(response: Response, alias: Option<&str>) -> Response {
    let Some(alias) = alias else {
        return response;
    };
    if !response.status().is_success() {
        return response;
    }
    let media = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if media != "text/event-stream" && media != "application/json" && !media.ends_with("+json") {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.remove(header::ETAG);
    if media == "text/event-stream" {
        let alias = alias.to_owned();
        let mut frames = Frames::default();
        let stream = body
            .into_data_stream()
            .map(move |chunk| frames.push(&chunk.map_err(io::Error::other)?, &alias));
        Response::from_parts(parts, Body::from_stream(stream))
    } else {
        let read = async {
            let bytes = axum::body::to_bytes(body, crate::MAX_BODY_BYTES)
                .await
                .map_err(|_| ())?;
            let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
            replace_model(&mut value, alias);
            serde_json::to_vec(&value).map_err(|_| ())
        };
        match tokio::time::timeout(crate::HEADER_TIMEOUT, read).await {
            Ok(Ok(bytes)) => Response::from_parts(parts, Body::from(bytes)),
            _ => crate::error(StatusCode::BAD_GATEWAY, "Invalid model alias response"),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_events_preserve_tools_usage_and_terminal_markers() {
        let source=b"event: response.created\r\ndata: {\"response\":{\"model\":\"upstream\"},\"tool\":{\"model\":\"leave-me\"}}\r\n\r\ndata: {\"model\":\"upstream\",\"usage\":{\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
        let mut state = Frames::default();
        let mut output = Vec::new();
        for part in source.chunks(3) {
            output.extend(state.push(part, "friendly").unwrap());
        }
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("event: response.created"));
        assert!(!output.contains("upstream"));
        assert!(output.contains("leave-me"));
        assert!(output.contains("\"completion_tokens\":2"));
        assert!(output.ends_with("data: [DONE]\n\n"));
        assert!(state.pending.is_empty());
        assert!(Frames::default()
            .push(&vec![b'x'; MAX_FRAME + 1], "friendly")
            .is_err());
    }
}
