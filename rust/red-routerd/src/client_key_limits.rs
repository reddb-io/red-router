//! A client key's runtime limits: its active-session cap (legacy
//! `api_keys.max_sessions`, enforced by `src/sse/handlers/chat.ts` with the
//! session registry of `open-sse/services/sessionManager.ts`) and its
//! per-request throttle delay (legacy `throttle_delay_ms`, applied by
//! `enforceApiKeyPolicy` after the rate check).

use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// The largest session cap a key may declare.
pub(crate) const MAX_KEY_SESSIONS: u32 = 10_000;
/// Legacy ceiling on a per-request throttle delay (`Math.min(.., 300_000)`).
pub(crate) const MAX_THROTTLE_DELAY_MS: u64 = 300_000;
/// Legacy `SESSION_TTL_MS`: a session idle this long no longer counts.
const SESSION_TTL_MS: u64 = 15 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyRuntimeLimits {
    /// Active sessions allowed at once; 0 is unlimited.
    #[serde(default)]
    pub max_sessions: u32,
    /// Delay before each admitted request; 0 is none.
    #[serde(default)]
    pub throttle_delay_ms: u64,
}

impl KeyRuntimeLimits {
    pub(crate) fn decode(raw: &str) -> Result<Self, &'static str> {
        let limits: Self = if raw.is_empty() {
            Self::default()
        } else {
            serde_json::from_str(raw).map_err(|_| "invalid client key runtime limits")?
        };
        limits.validate()?;
        Ok(limits)
    }

    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.max_sessions > MAX_KEY_SESSIONS || self.throttle_delay_ms > MAX_THROTTLE_DELAY_MS {
            return Err("invalid client key runtime limits");
        }
        Ok(())
    }

    pub(crate) fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_owned())
    }
}

/// Legacy `extractExternalSessionId`, else `generateSessionId(body)`: the
/// client's session header (prefixed so it never collides with a
/// fingerprint), or a fingerprint of the model, system prompt, first user
/// message and tool names.
pub(crate) fn session_id(headers: &HeaderMap, body: &Value) -> Option<String> {
    let external = [
        "x-session-id",
        "x_session_id",
        "x-omniroute-session",
        "session-id",
    ]
    .iter()
    .find_map(|name| headers.get(*name))
    .and_then(|value| value.to_str().ok())
    .map(str::trim)
    .filter(|value| !value.is_empty());
    if let Some(value) = external {
        return Some(format!(
            "ext:{}",
            value.chars().take(64).collect::<String>()
        ));
    }
    let body = body.as_object()?;
    let mut parts = Vec::new();
    if let Some(model) = body
        .get("model")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
    {
        parts.push(format!("model:{model}"));
    }
    let text = |value: &Value| match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    let messages = body
        .get("messages")
        .or_else(|| body.get("input"))
        .and_then(Value::as_array);
    let system = body
        .get("system")
        .filter(|value| !value.is_null() && value.as_str() != Some(""))
        .map(text)
        .or_else(|| {
            messages?
                .iter()
                .find(|message| {
                    matches!(
                        message.get("role").and_then(Value::as_str),
                        Some("system" | "developer")
                    )
                })
                .and_then(|message| message.get("content"))
                .map(text)
        });
    if let Some(system) = system {
        parts.push(format!("sys:{}", hash_short(&system)));
    }
    let first_user = messages.and_then(|messages| {
        messages
            .iter()
            .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
            .and_then(|message| message.get("content"))
            .map(text)
    });
    if let Some(first_user) = first_user {
        parts.push(format!("user0:{}", hash_short(&first_user)));
    }
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let mut names = tools
            .iter()
            .filter_map(|tool| {
                tool.get("name")
                    .or_else(|| {
                        tool.get("function")
                            .and_then(|function| function.get("name"))
                    })
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
            })
            .collect::<Vec<_>>();
        names.sort_unstable();
        if !names.is_empty() {
            parts.push(format!("tools:{}", hash_short(&names.join(","))));
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(hex::encode(Sha256::digest(parts.join("|").as_bytes()))[..16].to_owned())
}

fn hash_short(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))[..8].to_owned()
}

/// Active sessions per key, each with its last activity. A session counts
/// until it has been idle for the legacy TTL.
#[derive(Default)]
pub(crate) struct KeySessions {
    keys: Mutex<HashMap<String, HashMap<String, u64>>>,
}

impl KeySessions {
    /// Admit `session` for `key` under `max_sessions`, refreshing it. A known
    /// session is always admitted; a new one only while the key is below its
    /// cap (legacy `checkSessionLimit` + `registerKeySession`).
    pub(crate) fn admit(&self, key: &str, session: &str, max_sessions: u32, now_ms: u64) -> bool {
        let Ok(mut keys) = self.keys.lock() else {
            return false;
        };
        let sessions = keys.entry(key.to_owned()).or_default();
        sessions.retain(|_, last| now_ms.saturating_sub(*last) <= SESSION_TTL_MS);
        if let Some(last) = sessions.get_mut(session) {
            *last = now_ms;
            return true;
        }
        if sessions.len() >= max_sessions as usize {
            return false;
        }
        sessions.insert(session.to_owned(), now_ms);
        true
    }
}

/// The process-wide session registry, as the legacy in-memory one.
pub(crate) static KEY_SESSIONS: LazyLock<KeySessions> = LazyLock::new(KeySessions::default);

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use serde_json::json;

    #[test]
    fn runtime_limits_decode_validate_and_round_trip() {
        assert_eq!(
            KeyRuntimeLimits::decode("{}").unwrap(),
            KeyRuntimeLimits::default()
        );
        assert_eq!(
            KeyRuntimeLimits::decode("").unwrap(),
            KeyRuntimeLimits::default()
        );
        let limits = KeyRuntimeLimits {
            max_sessions: 3,
            throttle_delay_ms: 250,
        };
        assert_eq!(KeyRuntimeLimits::decode(&limits.encode()).unwrap(), limits);
        assert!(KeyRuntimeLimits::decode(r#"{"throttle_delay_ms":300001}"#).is_err());
        assert!(KeyRuntimeLimits::decode(r#"{"max_sessions":10001}"#).is_err());
        assert!(KeyRuntimeLimits::decode(r#"{"other":1}"#).is_err());
    }

    #[test]
    fn session_ids_prefer_the_client_header_then_a_body_fingerprint() {
        let mut headers = HeaderMap::new();
        headers.insert("x-session-id", HeaderValue::from_static("  abc  "));
        assert_eq!(session_id(&headers, &json!({})).as_deref(), Some("ext:abc"));

        let body = json!({
            "model":"m",
            "messages":[
                {"role":"system","content":"be brief"},
                {"role":"user","content":"hello"},
                {"role":"assistant","content":"hi"},
                {"role":"user","content":"later"}
            ],
            "tools":[{"function":{"name":"b"}},{"name":"a"}]
        });
        let empty = HeaderMap::new();
        let id = session_id(&empty, &body).unwrap();
        assert_eq!(id.len(), 16);
        // Later turns of the same conversation keep the same session.
        let mut later = body.clone();
        later["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"user","content":"more"}));
        assert_eq!(session_id(&empty, &later).unwrap(), id);
        let mut other = body.clone();
        other["messages"][1]["content"] = json!("different");
        assert_ne!(session_id(&empty, &other).unwrap(), id);
        assert_eq!(session_id(&empty, &json!({})), None);
    }

    #[test]
    fn a_key_admits_new_sessions_only_below_its_cap_until_they_idle_out() {
        let sessions = KeySessions::default();
        assert!(sessions.admit("k", "a", 2, 0));
        assert!(sessions.admit("k", "b", 2, 10));
        assert!(!sessions.admit("k", "c", 2, 20));
        // A known session is always admitted and refreshed.
        assert!(sessions.admit("k", "a", 2, 30));
        // Other keys are independent.
        assert!(sessions.admit("other", "c", 1, 30));
        // "b" idles out; "a" was refreshed at 30.
        assert!(sessions.admit("k", "c", 2, 10 + SESSION_TTL_MS + 1));
        assert!(!sessions.admit("k", "d", 2, 10 + SESSION_TTL_MS + 2));
    }
}
