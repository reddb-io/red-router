//! Read-only translation of a deliberately narrow dashboard combo.
//!
//! A route plan contains no credentials and is not an authorization decision
//! or a runnable FastLLM snapshot. The caller must enforce the full product
//! policies before accepting traffic. Unsupported combo semantics fail closed.

use crate::product_combo::ProductCombo;
use serde_json::{json, Value};
use std::path::Path;

/// The FastLLM listener is an internal boundary, not a public proxy URL.
/// Restrict it to a literal loopback address so redirects, DNS and proxies
/// cannot send the internal bearer token to another host.
pub fn validate_transport(url: &str, token: &str) -> Result<(), &'static str> {
    let url = url::Url::parse(url).map_err(|_| "invalid FastLLM transport URL")?;
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if url.scheme() != "http"
        || !loopback
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/v1/chat/completions"
    {
        return Err("FastLLM transport must be a literal loopback HTTP chat endpoint");
    }
    if !(32..=512).contains(&token.len())
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err("FastLLM internal token must be 32-512 ASCII token characters");
    }
    Ok(())
}

/// Translate a one-target priority combo using the product's SQLite reader.
/// Multi-target priority combos need explicit ordered fallback semantics in
/// FastLLM and cannot be represented by an unordered backend pool.
pub async fn single_target_plan(path: &Path, name: &str) -> Result<Value, &'static str> {
    let combo = ProductCombo::load(path, name).await?;
    if combo.targets.len() != 1 {
        return Err("FastLLM route plan requires exactly one combo target");
    }
    let target = &combo.targets[0];
    if !combo.unchanged().await {
        return Err("product combo changed while building FastLLM route plan");
    }
    Ok(json!({
        "format": "red-router.fastllm.route-plan.v1",
        "frontend_model": combo.name(),
        "provider": target.provider,
        "product_model": target.full_model,
        "upstream_model": target.model,
    }))
}

#[cfg(test)]
mod tests {
    use super::validate_transport;

    #[test]
    fn fastllm_transport_requires_a_private_loopback_endpoint_and_long_token() {
        let token = "internal-fastllm-token-12345678901234567890";
        assert!(validate_transport("http://127.0.0.1:8000/v1/chat/completions", token).is_ok());
        assert!(validate_transport("http://[::1]:8000/v1/chat/completions", token).is_ok());
        for url in [
            "http://localhost:8000/v1/chat/completions",
            "http://10.0.0.1:8000/v1/chat/completions",
            "https://127.0.0.1:8000/v1/chat/completions",
            "http://user@127.0.0.1:8000/v1/chat/completions",
            "http://127.0.0.1:8000/v1/chat/completions?redirect=x",
            "http://127.0.0.1:8000/v1/responses",
        ] {
            assert!(validate_transport(url, token).is_err(), "{url}");
        }
        assert!(validate_transport("http://127.0.0.1:8000/v1/chat/completions", "short").is_err());
        assert!(validate_transport(
            "http://127.0.0.1:8000/v1/chat/completions",
            "spaces are not allowed in this bearer token"
        )
        .is_err());
    }
}
