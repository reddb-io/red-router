//! Request idempotency for chat-like routes, ported from the legacy
//! `src/lib/idempotencyLayer.ts` and `open-sse/handlers/chatCore/idempotency.ts`.
//!
//! A request carrying `Idempotency-Key` (or `X-Request-Id`) that repeats a
//! completed non-streaming request inside the deduplication window (5 s, the
//! legacy default) gets the stored response again instead of a new upstream
//! call, marked `X-OmniRoute-Idempotent: true`. The effective key namespaces
//! the client's header key by the caller's credential (so different clients
//! never replay each other's responses), the route and a digest of the
//! request's semantic and generation fields (legacy `composeIdempotencyKey`).

use axum::{
    body::{to_bytes, Body},
    extract::Request,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{LazyLock, Mutex};

/// Legacy `DEFAULT_IDEMPOTENCY_WINDOW_MS`.
pub(crate) const WINDOW_MS: u64 = 5_000;
/// Bound on remembered responses; a full store skips saving.
const MAX_ENTRIES: usize = 10_000;
/// Bound on one remembered response body.
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const MAX_RAW_KEY_LEN: usize = 512;

/// Legacy `IDEMPOTENCY_SEMANTIC_FIELDS` plus the generation contract fields.
const DIGEST_FIELDS: &[&str] = &[
    "model",
    "messages",
    "input",
    "system",
    "temperature",
    "top_p",
    "stream",
    "previous_response_id",
    "conversation",
    "prompt",
    "include",
    "truncation",
    "service_tier",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "functions",
    "function_call",
    "response_format",
    "reasoning",
    "reasoning_effort",
    "thinking",
    "output_config",
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "top_k",
    "seed",
    "stop",
    "stop_sequences",
    "frequency_penalty",
    "presence_penalty",
    "repetition_penalty",
    "logit_bias",
    "n",
    "best_of",
    "logprobs",
    "top_logprobs",
    "text",
    "verbosity",
    "modalities",
    "audio",
    "prediction",
];

struct Entry {
    body: axum::body::Bytes,
    expires_at_ms: u64,
}

static STORE: LazyLock<Mutex<HashMap<String, Entry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Legacy `getIdempotencyKey`: `Idempotency-Key`, else `X-Request-Id`.
fn raw_key(headers: &HeaderMap) -> Option<&str> {
    ["idempotency-key", "x-request-id"]
        .iter()
        .find_map(|name| headers.get(*name))
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= MAX_RAW_KEY_LEN)
}

/// The effective key, or `None` when the body is not a JSON object.
pub(crate) fn compose_key(headers: &HeaderMap, path: &str, body: &[u8]) -> Option<String> {
    let raw = raw_key(headers)?;
    let Value::Object(request) = serde_json::from_slice::<Value>(body).ok()? else {
        return None;
    };
    // serde_json maps keep keys sorted, so this serialization is canonical.
    let semantic: serde_json::Map<String, Value> = DIGEST_FIELDS
        .iter()
        .filter_map(|field| {
            request
                .get(*field)
                .filter(|value| !value.is_null())
                .map(|value| ((*field).to_owned(), value.clone()))
        })
        .collect();
    let digest = hex::encode(Sha256::digest(
        serde_json::to_string(&semantic).ok()?.as_bytes(),
    ));
    let mut identity = Sha256::new();
    for name in ["authorization", "x-api-key", "x-goog-api-key"] {
        if let Some(value) = headers.get(name) {
            identity.update(name.as_bytes());
            identity.update([0]);
            identity.update(value.as_bytes());
            identity.update([0]);
        }
    }
    let identity = hex::encode(identity.finalize());
    serde_json::to_string(&["idempotency-v2", &identity, raw, path, &digest]).ok()
}

fn check(key: &str, now: u64) -> Option<axum::body::Bytes> {
    let mut store = STORE.lock().ok()?;
    match store.get(key) {
        Some(entry) if now < entry.expires_at_ms => Some(entry.body.clone()),
        Some(_) => {
            store.remove(key);
            None
        }
        None => None,
    }
}

fn save(key: String, body: axum::body::Bytes, now: u64) {
    let Ok(mut store) = STORE.lock() else {
        return;
    };
    store.retain(|_, entry| now < entry.expires_at_ms);
    if store.len() < MAX_ENTRIES {
        store.insert(
            key,
            Entry {
                body,
                expires_at_ms: now.saturating_add(WINDOW_MS),
            },
        );
    }
}

fn replay(body: axum::body::Bytes) -> Response {
    let mut response = Response::new(Body::from(body));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert("x-omniroute-idempotent", HeaderValue::from_static("true"));
    response
}

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("application/json"))
}

/// Forward `request`, replaying a completed response for a repeated key.
pub(crate) async fn with_idempotency<F, Fut>(request: Request, forward: F) -> Response
where
    F: FnOnce(Request) -> Fut,
    Fut: Future<Output = Response>,
{
    if raw_key(request.headers()).is_none() {
        return forward(request).await;
    }
    let (parts, body) = request.into_parts();
    let limit = crate::body_limits::request_body_limit(parts.uri.path());
    let Ok(bytes) = to_bytes(body, limit).await else {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            axum::Json(serde_json::json!({
                "error": {"message": "Request body too large", "type": "proxy_error"}
            })),
        )
            .into_response();
    };
    let key = compose_key(&parts.headers, parts.uri.path(), &bytes);
    if let Some(stored) = key.as_deref().and_then(|key| check(key, now_ms())) {
        return replay(stored);
    }
    let response = forward(Request::from_parts(parts, Body::from(bytes))).await;
    let Some(key) = key else {
        return response;
    };
    // Only a completed non-streaming success is remembered, as in the legacy
    // save site.
    if response.status() != StatusCode::OK || !is_json(response.headers()) {
        return response;
    }
    let (parts, body) = response.into_parts();
    match to_bytes(body, MAX_RESPONSE_BYTES).await {
        Ok(stored) => {
            save(key, stored.clone(), now_ms());
            Response::from_parts(parts, Body::from(stored))
        }
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            axum::Json(serde_json::json!({
                "error": {"message": "Upstream response too large", "type": "proxy_error"}
            })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_static(value));
        }
        map
    }

    #[test]
    fn keys_namespace_the_header_by_credential_route_and_request() {
        let body =
            br#"{"model":"m","messages":[{"role":"user","content":"hi"}],"metadata":{"x":1}}"#;
        let base = headers(&[("idempotency-key", "k1"), ("authorization", "Bearer a")]);
        let key = compose_key(&base, "/v1/chat/completions", body).unwrap();
        assert_eq!(
            compose_key(&base, "/v1/chat/completions", body),
            Some(key.clone())
        );
        // Fields outside the semantic contract do not change the key.
        let other_metadata =
            br#"{"model":"m","messages":[{"role":"user","content":"hi"}],"metadata":{"x":2}}"#;
        assert_eq!(
            compose_key(&base, "/v1/chat/completions", other_metadata),
            Some(key.clone())
        );
        let different_messages = br#"{"model":"m","messages":[{"role":"user","content":"yo"}]}"#;
        assert_ne!(
            compose_key(&base, "/v1/chat/completions", different_messages),
            Some(key.clone())
        );
        let other_client = headers(&[("idempotency-key", "k1"), ("authorization", "Bearer b")]);
        assert_ne!(
            compose_key(&other_client, "/v1/chat/completions", body),
            Some(key.clone())
        );
        assert_ne!(compose_key(&base, "/v1/responses", body), Some(key.clone()));
        let request_id = headers(&[("x-request-id", "k1"), ("authorization", "Bearer a")]);
        assert_eq!(
            compose_key(&request_id, "/v1/chat/completions", body),
            Some(key)
        );
        assert_eq!(
            compose_key(&HeaderMap::new(), "/v1/chat/completions", body),
            None
        );
        assert_eq!(compose_key(&base, "/v1/chat/completions", b"[]"), None);
    }

    #[test]
    fn stored_responses_replay_only_inside_the_window() {
        let key = "unit-test-window-key".to_owned();
        save(key.clone(), axum::body::Bytes::from_static(b"{}"), 1_000);
        assert!(check(&key, 1_000 + WINDOW_MS - 1).is_some());
        assert!(check(&key, 1_000 + WINDOW_MS).is_none());
        assert!(check(&key, 1_000).is_none(), "an expired entry is dropped");
    }
}
