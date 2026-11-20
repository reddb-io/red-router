//! Combo session stickiness, ported from the legacy
//! `open-sse/services/combo/sessionStickiness.ts`.
//!
//! A conversation is keyed by a hash of its first user message, scoped to
//! the combo. The connection that served it is remembered for fifteen
//! minutes (at most 500 conversations, least recently used evicted first),
//! and the next request of that conversation tries it first while it stays
//! healthy, so the provider's prompt cache keeps paying off. The state is
//! process-local, like the legacy map.

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// Legacy `TTL_MS`.
const TTL_MS: u64 = 15 * 60 * 1_000;
/// Legacy `MAX_ENTRIES`.
const MAX_ENTRIES: usize = 500;

struct Binding {
    connection: String,
    namespace: String,
    last_used_ms: u64,
}

static BINDINGS: LazyLock<Mutex<HashMap<String, Binding>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn hex16(digest: &[u8]) -> String {
    hex::encode(&digest[..8])
}

/// Legacy `normalizeStickinessMessages` and `deriveMessageHash`: the first
/// user message of a Chat Completions `messages` or Responses `input`.
fn message_hash(body: &serde_json::Value) -> Option<String> {
    let first_user_text = |items: &[serde_json::Value]| -> Option<String> {
        let first = items.iter().find_map(|item| match item {
            serde_json::Value::String(text) => Some(serde_json::Value::String(text.clone())),
            serde_json::Value::Object(record)
                if record.get("role").and_then(serde_json::Value::as_str) == Some("user") =>
            {
                Some(record.get("content").cloned().unwrap_or_default())
            }
            _ => None,
        })?;
        match first {
            serde_json::Value::String(text) => Some(text),
            serde_json::Value::Array(parts) => Some(
                parts
                    .iter()
                    .filter(|part| part.is_object())
                    .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
                    .collect(),
            ),
            _ => None,
        }
    };
    let text = match (body.get("messages"), body.get("input")) {
        (Some(serde_json::Value::Array(messages)), _) if !messages.is_empty() => {
            // A plain string in `messages` has no role: legacy skips it.
            first_user_text(
                &messages
                    .iter()
                    .filter(|message| message.is_object())
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        }
        (_, Some(serde_json::Value::String(input))) if !input.is_empty() => Some(input.clone()),
        (_, Some(serde_json::Value::Array(input))) if !input.is_empty() => first_user_text(input),
        _ => None,
    }?;
    (!text.is_empty()).then(|| hex16(&Sha256::digest(text.as_bytes())))
}

/// The conversation key of a request to a combo (legacy `scopeMessageHash`).
pub(crate) fn request_key(namespace: &str, body: &serde_json::Value) -> Option<String> {
    let hash = message_hash(body)?;
    let mut digest = Sha256::new();
    digest.update(namespace.as_bytes());
    digest.update([0]);
    digest.update(hash.as_bytes());
    Some(hex16(&digest.finalize()))
}

/// The connection bound to a conversation, while the binding is fresh.
pub(crate) fn bound_connection(key: &str, now_ms: u64) -> Option<String> {
    let mut bindings = BINDINGS.lock().ok()?;
    let binding = bindings.get(key)?;
    if now_ms.saturating_sub(binding.last_used_ms) > TTL_MS {
        bindings.remove(key);
        return None;
    }
    Some(binding.connection.clone())
}

/// Refresh a binding the request is about to reuse.
pub(crate) fn touch(key: &str, now_ms: u64) {
    if let Ok(mut bindings) = BINDINGS.lock() {
        if let Some(binding) = bindings.get_mut(key) {
            binding.last_used_ms = now_ms;
        }
    }
}

/// Legacy `clearStickyBinding`.
pub(crate) fn clear(key: &str) {
    if let Ok(mut bindings) = BINDINGS.lock() {
        bindings.remove(key);
    }
}

/// Legacy `clearStickyBindingsForCombo`.
pub(crate) fn clear_namespace(namespace: &str) {
    if let Ok(mut bindings) = BINDINGS.lock() {
        bindings.retain(|_, binding| binding.namespace != namespace);
    }
}

/// Legacy `recordStickyBinding`, with its TTL and size eviction.
pub(crate) fn record(key: &str, namespace: &str, connection: &str, now_ms: u64) {
    let Ok(mut bindings) = BINDINGS.lock() else {
        return;
    };
    if let Some(binding) = bindings.get_mut(key) {
        binding.connection = connection.to_owned();
        binding.namespace = namespace.to_owned();
        binding.last_used_ms = now_ms;
        return;
    }
    bindings.retain(|_, binding| now_ms.saturating_sub(binding.last_used_ms) <= TTL_MS);
    while bindings.len() >= MAX_ENTRIES {
        let Some(oldest) = bindings
            .iter()
            .min_by_key(|(_, binding)| binding.last_used_ms)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        bindings.remove(&oldest);
    }
    bindings.insert(
        key.to_owned(),
        Binding {
            connection: connection.to_owned(),
            namespace: namespace.to_owned(),
            last_used_ms: now_ms,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_conversation_is_keyed_by_its_first_user_message() {
        let key = |body: serde_json::Value| request_key("combo", &body);
        let chat = key(json!({"messages":[
            {"role":"system","content":"rules"},
            {"role":"user","content":"hello"},
            {"role":"user","content":"later"}
        ]}));
        assert!(chat.is_some());
        assert_eq!(
            chat,
            key(
                json!({"messages":[{"role":"user","content":[{"type":"text","text":"hel"},{"type":"text","text":"lo"}]}]})
            )
        );
        assert_eq!(chat, key(json!({"input":"hello"})));
        assert_eq!(chat, key(json!({"input":["hello"]})));
        assert_ne!(chat, request_key("other", &json!({"input":"hello"})));
        assert_eq!(
            key(json!({"messages":[{"role":"system","content":"x"}]})),
            None
        );
        assert_eq!(
            key(json!({"messages":[{"role":"user","content":""}]})),
            None
        );
        assert_eq!(key(json!({"messages":[]})), None);
    }

    #[test]
    fn bindings_expire_and_are_replaced() {
        let (key, namespace) = ("session-test-key", "session-test-namespace");
        record(key, namespace, "first", 1_000);
        assert_eq!(bound_connection(key, 1_000).as_deref(), Some("first"));
        record(key, namespace, "second", 2_000);
        assert_eq!(bound_connection(key, 2_000).as_deref(), Some("second"));
        touch(key, 10_000);
        assert_eq!(
            bound_connection(key, 10_000 + TTL_MS).as_deref(),
            Some("second")
        );
        assert_eq!(bound_connection(key, 10_001 + TTL_MS), None);
        record(key, namespace, "third", 3_000);
        clear_namespace(namespace);
        assert_eq!(bound_connection(key, 3_000), None);
    }
}
