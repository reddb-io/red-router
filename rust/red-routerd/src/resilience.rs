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
}
