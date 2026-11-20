//! Edge errors that forbid retries, ported from the legacy
//! `open-sse/services/accountFallback/nonRetryableUpstream.ts` (#8775).
//!
//! A Cloudflare 1010 (`browser_signature_banned`) or an explicit
//! `retryable: false` with Cloudflare or owner-action signals bans the
//! client signature, not the account: the request moves on without a
//! connection cooldown that a retry would only wait out.

use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

static ERROR_CODE_1010: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""error_code"\s*:\s*1010\b"#).expect("static pattern"));
static RETRYABLE_FALSE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""retryable"\s*:\s*false"#).expect("static pattern"));
static CLOUDFLARE_ERROR_TRUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""cloudflare_error"\s*:\s*true"#).expect("static pattern"));
static OWNER_ACTION_TRUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""owner_action_required"\s*:\s*true"#).expect("static pattern"));

/// Legacy `hasCloudflareBanSignal`.
fn has_cloudflare_ban_signal(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Number(number)) => number.as_f64() == Some(1010.0),
        Some(Value::String(text)) => {
            let lower = text.to_lowercase();
            lower.contains("browser_signature_banned")
                || lower.contains("error 1010")
                || lower == "1010"
                || lower.contains("cloudflare")
        }
        _ => false,
    }
}

/// Legacy `isNonRetryableCloudflareError`.
pub fn is_non_retryable_cloudflare_error(error_text: &str) -> bool {
    if error_text.is_empty() {
        return false;
    }
    let trimmed = error_text.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(trimmed) {
            let truthy = |name: &str, alias: &str| {
                object.get(name) == Some(&Value::Bool(true))
                    || object.get(alias) == Some(&Value::Bool(true))
            };
            let not_retryable = object.get("retryable") == Some(&Value::Bool(false));
            let code = object.get("error_code").or_else(|| object.get("errorCode"));
            if code == Some(&Value::from(1010)) || code == Some(&Value::from("1010")) {
                return true;
            }
            if object
                .get("error_name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.eq_ignore_ascii_case("browser_signature_banned"))
            {
                return true;
            }
            if not_retryable
                && (truthy("cloudflare_error", "cloudflareError")
                    || truthy("owner_action_required", "ownerActionRequired"))
            {
                return true;
            }
            let signal = object
                .get("title")
                .or_else(|| object.get("type"))
                .or_else(|| object.get("detail"));
            if not_retryable && has_cloudflare_ban_signal(signal) {
                return true;
            }
        }
    }
    let lower = error_text.to_lowercase();
    lower.contains("browser_signature_banned")
        || ERROR_CODE_1010.is_match(error_text)
        || (RETRYABLE_FALSE.is_match(error_text)
            && (CLOUDFLARE_ERROR_TRUE.is_match(error_text)
                || OWNER_ACTION_TRUE.is_match(error_text)
                || lower.contains("cloudflare")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Ported from tests/unit/account-fallback-cf1010-no-retry-8775.test.ts.
    #[test]
    fn cloudflare_signature_bans_forbid_retries() {
        let body = json!({
            "type": "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/",
            "title": "Error 1010: Access denied",
            "status": 403,
            "error_code": 1010,
            "error_name": "browser_signature_banned",
            "cloudflare_error": true,
            "retryable": false,
            "owner_action_required": true
        })
        .to_string();
        assert!(is_non_retryable_cloudflare_error(&body));
        assert!(!is_non_retryable_cloudflare_error("invalid api key"));
        assert!(!is_non_retryable_cloudflare_error(
            r#"{"error":"forbidden"}"#
        ));
        assert!(is_non_retryable_cloudflare_error(
            r#"{"cloudflare_error":true,"retryable":false,"error_code":1010,"error_name":"browser_signature_banned"}"#
        ));
        assert!(is_non_retryable_cloudflare_error(
            r#"{"retryable":false,"title":"Cloudflare blocked"}"#
        ));
        assert!(is_non_retryable_cloudflare_error(
            r#"upstream said: {"error_code": 1010}"#
        ));
        assert!(!is_non_retryable_cloudflare_error(r#"{"retryable":false}"#));
        assert!(!is_non_retryable_cloudflare_error(""));
    }
}
