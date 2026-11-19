//! Client request body limits, ported from the legacy
//! `src/shared/middleware/bodySizeGuard.ts` and `src/shared/constants/bodySize.ts`.
//!
//! The configured limit defaults to 10 MiB and can be set with the legacy
//! `MAX_BODY_SIZE_BYTES` environment variable. Chat Completions and Responses
//! accept at least the legacy LLM API limit of 50 MiB, so requests carrying
//! inline images or long histories are not cut at the general limit.

use std::sync::LazyLock;

const MIB: usize = 1024 * 1024;
/// Legacy `DEFAULT_REQUEST_BODY_LIMIT_BYTES`.
pub(crate) const DEFAULT_REQUEST_BODY_LIMIT_BYTES: usize = 10 * MIB;
/// Legacy `MAX_BODY_BYTES_LLM_API`.
pub(crate) const LLM_API_BODY_LIMIT_BYTES: usize = 50 * MIB;

/// Legacy `parseRequestBodyLimitBytes`: a positive byte count, else the default.
fn parse_limit(value: Option<&str>) -> usize {
    value
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .map_or(DEFAULT_REQUEST_BODY_LIMIT_BYTES, |value| value as usize)
}

static CONFIGURED_LIMIT: LazyLock<usize> =
    LazyLock::new(|| parse_limit(std::env::var("MAX_BODY_SIZE_BYTES").ok().as_deref()));

/// Legacy `getBodySizeLimit` for the routes the native gateway serves.
pub(crate) fn request_body_limit(path: &str) -> usize {
    limit_for(path, *CONFIGURED_LIMIT)
}

fn limit_for(path: &str, configured: usize) -> usize {
    let path = path.strip_prefix("/api").unwrap_or(path);
    if path.starts_with("/v1/chat/completions") || path.starts_with("/v1/responses") {
        LLM_API_BODY_LIMIT_BYTES.max(configured)
    } else {
        configured
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_follow_the_legacy_body_size_guard() {
        assert_eq!(parse_limit(None), DEFAULT_REQUEST_BODY_LIMIT_BYTES);
        assert_eq!(parse_limit(Some("0")), DEFAULT_REQUEST_BODY_LIMIT_BYTES);
        assert_eq!(
            parse_limit(Some("not a number")),
            DEFAULT_REQUEST_BODY_LIMIT_BYTES
        );
        assert_eq!(parse_limit(Some(" 2048 ")), 2_048);

        let configured = DEFAULT_REQUEST_BODY_LIMIT_BYTES;
        for path in [
            "/v1/chat/completions",
            "/api/v1/chat/completions",
            "/v1/responses",
            "/v1/responses/compact",
        ] {
            assert_eq!(
                limit_for(path, configured),
                LLM_API_BODY_LIMIT_BYTES,
                "{path}"
            );
        }
        for path in ["/v1/messages", "/v1/embeddings", "/v1/rerank"] {
            assert_eq!(limit_for(path, configured), configured, "{path}");
        }
        // A configured limit above the LLM floor raises it too.
        assert_eq!(limit_for("/v1/chat/completions", 80 * MIB), 80 * MIB);
    }
}
