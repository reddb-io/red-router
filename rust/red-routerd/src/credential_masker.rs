//! The credential masker guardrail, ported from the legacy
//! `src/lib/guardrails/credentialMasker.ts`.
//!
//! Opt-in (`credentialRedactionEnabled`, or `CREDENTIAL_REDACTION_ENABLED`):
//! well-known API key and secret shapes are redacted from the request sent
//! upstream and from the answer returned to the client, so neither side sees
//! a credential pasted into a conversation.

use serde_json::Value;

/// Legacy `isSensitiveHeaderKey`.
fn sensitive_header_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "authorization" | "x-api-key" | "api-key" | "apikey"
    )
}

/// Legacy `redactHeaderValue`: the scheme prefix stays.
fn redact_header_value(value: &str) -> String {
    let leading = value.len() - value.trim_start().len();
    let rest = &value[leading..];
    let scheme = ["bearer", "basic", "token"]
        .iter()
        .find_map(|scheme| {
            let head = rest.get(..scheme.len())?;
            let after = &rest[scheme.len()..];
            let spaces = after.len() - after.trim_start().len();
            (head.eq_ignore_ascii_case(scheme) && spaces > 0).then_some(scheme.len() + spaces)
        })
        .unwrap_or(0);
    format!("{}[REDACTED:auth_header]", &value[..leading + scheme])
}

/// Legacy `isImageDataUrl`: base64 image data is transport, not text.
fn is_image_data_url(value: &str) -> bool {
    value.strip_prefix("data:image/").is_some_and(|rest| {
        rest.split_once(";base64,").is_some_and(|(kind, _)| {
            !kind.is_empty()
                && kind
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
        })
    })
}

/// Legacy `walkValue`: every string redacted, sensitive header values replaced
/// after their scheme. Returns how many credentials were redacted.
pub fn redact_value(value: &mut Value) -> usize {
    match value {
        Value::String(text) => {
            if is_image_data_url(text) {
                return 0;
            }
            let (redacted, detections) = crate::credential_patterns::redact_credentials(text);
            if redacted != *text {
                *text = redacted;
            }
            detections.iter().map(|(_, count)| count).sum()
        }
        Value::Array(items) => items.iter_mut().map(redact_value).sum(),
        Value::Object(record) => record
            .iter_mut()
            .map(|(key, entry)| match entry {
                Value::String(header) if sensitive_header_key(key) => {
                    let redacted = redact_header_value(header);
                    if redacted == *header {
                        0
                    } else {
                        *header = redacted;
                        1
                    }
                }
                other => redact_value(other),
            })
            .sum(),
        _ => 0,
    }
}

/// Whether the guardrail is on: the native setting or the legacy variable.
pub fn enabled(setting: bool) -> bool {
    setting || std::env::var("CREDENTIAL_REDACTION_ENABLED").is_ok_and(|value| value == "true")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Ported from tests/unit/credential-masker-guardrail.test.ts and
    // tests/unit/credential-masker-image-data-url-13462.test.ts.
    #[test]
    fn payloads_and_answers_lose_their_credentials() {
        let key = format!("sk-proj-{}", "a".repeat(30));
        let mut payload = json!({
            "messages": [{"role": "user", "content": format!("my key is {key}")}],
            "metadata": {"headers": {"Authorization": "Bearer shared-token-value"}},
            "image": "data:image/png;base64,c2stcHJvai1hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE="
        });
        assert_eq!(redact_value(&mut payload), 2);
        assert_eq!(
            payload["messages"][0]["content"],
            "my key is [REDACTED:openai]"
        );
        assert_eq!(
            payload["metadata"]["headers"]["Authorization"],
            "Bearer [REDACTED:auth_header]"
        );
        assert!(payload["image"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        // An already-redacted header is not counted again.
        assert_eq!(redact_value(&mut payload), 0);
        let mut plain = json!({"api-key": "abc123def456", "note": "nothing secret"});
        assert_eq!(redact_value(&mut plain), 1);
        assert_eq!(plain["api-key"], "[REDACTED:auth_header]");
        assert_eq!(
            redact_header_value("Token  xyz"),
            "Token  [REDACTED:auth_header]"
        );
        assert!(!is_image_data_url("data:text/plain;base64,abc"));
    }
}
