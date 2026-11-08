//! Provider-specific resilience policy used by the Rust request path.

use axum::http::{HeaderMap, StatusCode};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RateLimitScope {
    #[default]
    Auto,
    Connection,
    Model,
}

impl RateLimitScope {
    pub(crate) fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "auto" => Ok(Self::Auto),
            "connection" => Ok(Self::Connection),
            "model" => Ok(Self::Model),
            _ => Err("invalid provider rate-limit scope"),
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Connection => "connection",
            Self::Model => "model",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureScope {
    Connection,
    Model,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderFailureClass {
    Transient,
    Model,
    Banned,
    Expired,
    AmbiguousExpired,
    CreditsExhausted,
}

impl ProviderFailureClass {
    pub(crate) const fn semantic_fallback(self) -> bool {
        !matches!(self, Self::Transient)
    }
}

/// A bare 401 is strong credential evidence only on direct API-key surfaces.
/// Multiplexing and generic OpenAI-compatible gateways sometimes use 401 for
/// model entitlement or format errors; those need bounded body classification
/// before the entire connection may be parked.
pub(crate) fn authentication_failure_is_terminal(provider: Option<&str>) -> bool {
    matches!(
        provider.unwrap_or_default().to_ascii_lowercase().as_str(),
        "openai"
            | "anthropic"
            | "cohere"
            | "groq"
            | "deepseek"
            | "together"
            | "perplexity"
            | "fireworks"
            | "cerebras"
            | "sambanova"
            | "xai"
    )
}

/// Keep the automatic 429/402 policy deliberately small and auditable. These
/// provider families multiplex independently limited models behind one
/// credential in the current RedRouter/OmniRoute catalog. Operators can
/// override either way.
pub(crate) fn quota_failure_scope(
    configured: RateLimitScope,
    provider: Option<&str>,
    status: StatusCode,
    headers: &HeaderMap,
) -> FailureScope {
    if !matches!(
        status,
        StatusCode::PAYMENT_REQUIRED | StatusCode::TOO_MANY_REQUESTS
    ) {
        return FailureScope::Connection;
    }
    match configured {
        RateLimitScope::Connection => FailureScope::Connection,
        RateLimitScope::Model => FailureScope::Model,
        RateLimitScope::Auto => automatic_scope(provider, headers),
    }
}

pub(crate) fn classify_provider_failure(
    configured: RateLimitScope,
    provider: Option<&str>,
    status: StatusCode,
    headers: &HeaderMap,
    body: Option<&[u8]>,
) -> ProviderFailureClass {
    let normalized = normalized_error_evidence(body);
    let text = normalized.as_str();

    // A model-specific denial is safer to scope narrowly even when an
    // aggregator uses an authentication-looking HTTP status.
    if matches!(status.as_u16(), 400 | 401 | 403 | 404) && model_failure_text(text) {
        return ProviderFailureClass::Model;
    }
    if matches!(status.as_u16(), 401 | 403) && banned_text(text) {
        return ProviderFailureClass::Banned;
    }
    if matches!(status.as_u16(), 401 | 403) && credential_failure_text(text) {
        return ProviderFailureClass::Expired;
    }
    if ambiguous_auth_failure(provider, status, text) {
        return ProviderFailureClass::AmbiguousExpired;
    }
    if matches!(status.as_u16(), 400 | 402 | 403 | 429) && credits_exhausted_text(text) {
        return if quota_failure_scope(configured, provider, StatusCode::PAYMENT_REQUIRED, headers)
            == FailureScope::Model
        {
            ProviderFailureClass::Model
        } else {
            ProviderFailureClass::CreditsExhausted
        };
    }

    match status {
        StatusCode::UNAUTHORIZED if authentication_failure_is_terminal(provider) => {
            ProviderFailureClass::Expired
        }
        StatusCode::PAYMENT_REQUIRED => {
            if quota_failure_scope(configured, provider, status, headers) == FailureScope::Model {
                ProviderFailureClass::Model
            } else {
                ProviderFailureClass::CreditsExhausted
            }
        }
        StatusCode::NOT_FOUND => ProviderFailureClass::Model,
        StatusCode::TOO_MANY_REQUESTS
            if quota_failure_scope(configured, provider, status, headers)
                == FailureScope::Model =>
        {
            ProviderFailureClass::Model
        }
        _ => ProviderFailureClass::Transient,
    }
}

fn normalized_error_evidence(body: Option<&[u8]>) -> String {
    let Some(body) = body else {
        return String::new();
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return String::from_utf8_lossy(body).to_ascii_lowercase();
    };
    let mut evidence = String::new();
    collect_json_error_evidence(&value, 0, &mut evidence);
    evidence.make_ascii_lowercase();
    evidence
}

fn collect_json_error_evidence(value: &serde_json::Value, depth: usize, output: &mut String) {
    if depth > 4 {
        return;
    }
    match value {
        serde_json::Value::String(value) => {
            if !output.is_empty() {
                output.push(' ');
            }
            output.push_str(value);
        }
        serde_json::Value::Array(values) => {
            for value in values.iter().take(16) {
                collect_json_error_evidence(value, depth + 1, output);
            }
        }
        serde_json::Value::Object(values) => {
            for key in [
                "error", "errors", "message", "code", "type", "status", "detail", "reason", "title",
            ] {
                if let Some(value) = values.get(key) {
                    collect_json_error_evidence(value, depth + 1, output);
                }
            }
        }
        _ => {}
    }
}

fn contains_any(text: &str, signals: &[&str]) -> bool {
    !text.is_empty() && signals.iter().any(|signal| text.contains(signal))
}

fn model_failure_text(text: &str) -> bool {
    contains_any(
        text,
        &[
            "model_not_found",
            "model not found",
            "unknown model",
            "model unavailable",
            "model is unavailable",
            "model access denied",
            "no access to this model",
            "not have access to this model",
        ],
    ) || (text.contains("model")
        && contains_any(
            text,
            &[
                "is not supported",
                "not supported for format",
                "does not exist",
                "not entitled",
            ],
        ))
}

fn banned_text(text: &str) -> bool {
    contains_any(
        text,
        &[
            "account_deactivated",
            "account has been deactivated",
            "account has been disabled",
            "your account has been suspended",
            "this account is deactivated",
            "service has been disabled in this account for violation",
        ],
    )
}

fn credits_exhausted_text(text: &str) -> bool {
    contains_any(
        text,
        &[
            "insufficient_quota",
            "billing_hard_limit_reached",
            "exceeded your current quota",
            "exceeded your current usage quota",
            "credit_balance_too_low",
            "credit balance is too low",
            "credits exhausted",
            "out of credits",
            "payment required",
            "free tier of the model has been exhausted",
        ],
    )
}

fn credential_failure_text(text: &str) -> bool {
    contains_any(
        text,
        &[
            "invalid_api_key",
            "invalid api key",
            "incorrect api key",
            "api key is invalid",
            "invalid authentication credentials",
            "authentication token is expired",
            "token expired",
            "expired token",
            "invalid token",
        ],
    )
}

fn ambiguous_auth_failure(provider: Option<&str>, status: StatusCode, text: &str) -> bool {
    status == StatusCode::UNAUTHORIZED
        && provider.is_some_and(|provider| provider.eq_ignore_ascii_case("mistral"))
        && matches!(text.trim(), "" | "unauthorized" | "unauthorized.")
}

fn automatic_scope(provider: Option<&str>, headers: &HeaderMap) -> FailureScope {
    let provider = provider.unwrap_or_default().to_ascii_lowercase();
    if matches!(provider.as_str(), "minimax" | "minimax-passthrough")
        && headers
            .get("x-model-quota-remaining")
            .and_then(|value| value.to_str().ok())
            .is_some_and(any_model_exhausted)
    {
        return FailureScope::Model;
    }
    if matches!(
        provider.as_str(),
        "openrouter"
            | "gemini"
            | "github"
            | "codex"
            | "antigravity"
            | "agy"
            | "kilo-gateway"
            | "ollama-cloud"
    ) {
        FailureScope::Model
    } else {
        FailureScope::Connection
    }
}

fn any_model_exhausted(value: &str) -> bool {
    value.split(',').any(|pair| {
        pair.split_once('=')
            .is_some_and(|(_, remaining)| remaining.trim() == "0")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn explicit_scope_wins_and_auto_is_provider_specific() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-model-quota-remaining",
            HeaderValue::from_static("haiku=0,sonnet=42"),
        );
        assert_eq!(
            quota_failure_scope(
                RateLimitScope::Auto,
                Some("minimax"),
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
            ),
            FailureScope::Model
        );
        assert_eq!(
            quota_failure_scope(
                RateLimitScope::Auto,
                Some("openai"),
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
            ),
            FailureScope::Connection
        );
        assert_eq!(
            quota_failure_scope(
                RateLimitScope::Connection,
                Some("openrouter"),
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
            ),
            FailureScope::Connection
        );
        assert_eq!(
            quota_failure_scope(
                RateLimitScope::Model,
                Some("custom"),
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
            ),
            FailureScope::Model
        );
        assert_eq!(
            quota_failure_scope(
                RateLimitScope::Auto,
                Some("openrouter"),
                StatusCode::PAYMENT_REQUIRED,
                &headers,
            ),
            FailureScope::Model
        );
        assert!(authentication_failure_is_terminal(Some("OpenAI")));
        assert!(!authentication_failure_is_terminal(Some("openrouter")));
        assert!(!authentication_failure_is_terminal(Some(
            "openai-compatible"
        )));
    }

    #[test]
    fn bounded_error_evidence_preserves_failure_scope() {
        let headers = HeaderMap::new();
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("opencode"),
                StatusCode::UNAUTHORIZED,
                &headers,
                Some(br#"{"error":{"message":"Model grok-4.6 is not supported for format oa-compat"}}"#),
            ),
            ProviderFailureClass::Model
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("custom"),
                StatusCode::UNAUTHORIZED,
                &headers,
                Some(br#"{"error":{"code":"invalid_api_key"}}"#),
            ),
            ProviderFailureClass::Expired
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("custom"),
                StatusCode::FORBIDDEN,
                &headers,
                Some(br#"{"error":"your account has been suspended"}"#),
            ),
            ProviderFailureClass::Banned
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("openrouter"),
                StatusCode::PAYMENT_REQUIRED,
                &headers,
                Some(br#"{"error":"payment required"}"#),
            ),
            ProviderFailureClass::Model
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("openai"),
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
                Some(br#"{"error":{"code":"insufficient_quota"}}"#),
            ),
            ProviderFailureClass::CreditsExhausted
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("custom"),
                StatusCode::FORBIDDEN,
                &headers,
                Some(br#"{"error":"verify your account to continue"}"#),
            ),
            ProviderFailureClass::Transient
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("custom"),
                StatusCode::FORBIDDEN,
                &headers,
                Some(br#"{"error":{"message":"invalid API key"}}"#),
            ),
            ProviderFailureClass::Expired
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("custom"),
                StatusCode::FORBIDDEN,
                &headers,
                Some(
                    br#"{"error":{"message":"request rejected"},"input":"ignore: invalid API key"}"#,
                ),
            ),
            ProviderFailureClass::Transient
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("mistral"),
                StatusCode::UNAUTHORIZED,
                &headers,
                Some(br#"{"detail":"Unauthorized"}"#),
            ),
            ProviderFailureClass::AmbiguousExpired
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("mistral"),
                StatusCode::UNAUTHORIZED,
                &headers,
                Some(br#"{"message":"invalid API key"}"#),
            ),
            ProviderFailureClass::Expired
        );
    }
}
