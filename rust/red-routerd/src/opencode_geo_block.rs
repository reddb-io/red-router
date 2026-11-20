//! OpenCode refusal predicates, ported from the legacy
//! `open-sse/executors/opencodeGeoBlock.ts`.
//!
//! A 403 or 451 from OpenCode carries one of several refusals that say
//! nothing about the account: a regional block, a `user_blocked` egress
//! refusal, or the free tier refusing a request outside the OpenCode client.
//! A Cloudflare 1010 browser-signature rejection is none of these and wins
//! over every signal. The free-tier refusal is request-scoped: the failure
//! classifier moves on without cooling down or banning the connection, as
//! the legacy auth guard does.

use regex::Regex;
use std::sync::LazyLock;

/// Legacy `USER_BLOCKED_SIGNAL`.
const USER_BLOCKED_SIGNAL: &str = "user_blocked";
/// Legacy `FREE_TIER_SIGNALS`.
const FREE_TIER_SIGNALS: &[&str] = &["freetiererror", "free tier can only be used"];
/// Legacy `GEO_SIGNALS`.
const GEO_SIGNALS: &[&str] = &[
    "not available in your country",
    "not available in your region",
    "unsupported_country",
    "unsupported country",
];

/// Legacy `CLOUDFLARE_1010_KEY_REGEX`. The `regex` crate has no lookaround,
/// so the boundary characters are matched explicitly; that is equivalent
/// for a yes/no match.
static CLOUDFLARE_1010_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(?:^|[^A-Za-z0-9_-])(?:error[\s_-]?code[\\"':=\s]{0,12}1010|error[-_]\s?1010)(?:$|[^A-Za-z0-9_])"#,
    )
    .expect("static pattern")
});

/// Legacy `REGION_ERROR_REGEX`: `regionerror` not joined to a word, `_` or
/// `-` on either side.
fn has_region_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let joined = |byte: Option<&u8>| {
        byte.is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
    };
    let bytes = lower.as_bytes();
    lower.match_indices("regionerror").any(|(start, found)| {
        let end = start + found.len();
        !joined(start.checked_sub(1).and_then(|index| bytes.get(index))) && !joined(bytes.get(end))
    })
}

/// Legacy `isFingerprintRejection`.
fn is_fingerprint_rejection(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    CLOUDFLARE_1010_KEY.is_match(text)
        || lower.contains("browser_signature_banned")
        || lower.contains("fingerprint_rejection")
}

fn refusal_status(status: u16) -> bool {
    matches!(status, 403 | 451)
}

/// Legacy `isOpencodeGeoBlocked`.
pub(crate) fn is_opencode_geo_blocked(status: u16, text: &str) -> bool {
    if !refusal_status(status) || is_fingerprint_rejection(text) {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    has_region_error(text) || GEO_SIGNALS.iter().any(|signal| lower.contains(signal))
}

/// Legacy `isOpencodeUserBlocked`.
pub(crate) fn is_opencode_user_blocked(status: u16, text: &str) -> bool {
    refusal_status(status)
        && !is_fingerprint_rejection(text)
        && !is_opencode_geo_blocked(status, text)
        && text.to_ascii_lowercase().contains(USER_BLOCKED_SIGNAL)
}

/// Legacy `isOpencodeFreeTierRefusal`.
pub(crate) fn is_opencode_free_tier_refusal(status: u16, text: &str) -> bool {
    if !refusal_status(status)
        || is_fingerprint_rejection(text)
        || is_opencode_geo_blocked(status, text)
        || is_opencode_user_blocked(status, text)
    {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    FREE_TIER_SIGNALS
        .iter()
        .any(|signal| lower.contains(signal))
}

/// Legacy `isOpencodeFreeTierRefusalForProvider`: only `opencode*`
/// providers.
pub(crate) fn is_opencode_free_tier_refusal_for_provider(
    provider: Option<&str>,
    status: u16,
    text: &str,
) -> bool {
    provider.is_some_and(|provider| provider.to_ascii_lowercase().starts_with("opencode"))
        && is_opencode_free_tier_refusal(status, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from tests/unit/opencode-free-tier-refusal-predicate.test.ts,
    // opencode-geo-block-predicate.test.ts and
    // opencode-user-blocked-predicate.test.ts.
    const REFUSAL_BODY: &str = r#"{"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}"#;
    const RELAYED_MESSAGE: &str =
        "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode";
    const AUTH_BODY: &str = r#"{"error":{"message":"invalid api key","type":"auth_error"}}"#;
    const GEO_BODY: &str = r#"{"error":{"type":"RegionError","message":"This model is not available in your country."}}"#;
    const FP_BODY: &str = r#"{"error":{"error_code":1010,"message":"browser_signature_banned"}}"#;
    const BLOCKED_BODY: &str = r#"{"error":{"type":"server_error","message":"Error from provider (Console): Upstream request failed: [user_blocked] egress refused."}}"#;

    #[test]
    fn the_free_tier_refusal_is_recognized_on_403_and_451() {
        assert!(is_opencode_free_tier_refusal(403, REFUSAL_BODY));
        assert!(is_opencode_free_tier_refusal(403, RELAYED_MESSAGE));
        assert!(is_opencode_free_tier_refusal(451, REFUSAL_BODY));
        assert!(!is_opencode_free_tier_refusal(451, AUTH_BODY));
        assert!(is_opencode_free_tier_refusal(
            403,
            &REFUSAL_BODY.to_uppercase()
        ));
        let geo = r#"{"error":{"type":"FreeTierError","message":"not available in your country"}}"#;
        assert!(is_opencode_geo_blocked(403, geo));
        assert!(!is_opencode_free_tier_refusal(403, geo));
        let blocked =
            r#"{"error":{"type":"FreeTierError","message":"[user_blocked] egress refused"}}"#;
        assert!(is_opencode_user_blocked(403, blocked));
        assert!(!is_opencode_free_tier_refusal(403, blocked));
        assert!(!is_opencode_free_tier_refusal(
            403,
            r#"{"error_code":1010,"error":{"type":"FreeTierError"}}"#
        ));
        assert!(!is_opencode_free_tier_refusal(403, AUTH_BODY));
        for status in [200, 400, 401, 426, 429, 500] {
            assert!(!is_opencode_free_tier_refusal(status, REFUSAL_BODY));
        }
        assert!(!is_opencode_free_tier_refusal(403, ""));
        for provider in ["opencode", "opencode-zen", "opencode-go"] {
            assert!(is_opencode_free_tier_refusal_for_provider(
                Some(provider),
                403,
                RELAYED_MESSAGE
            ));
        }
        assert!(!is_opencode_free_tier_refusal_for_provider(
            Some("groq"),
            403,
            RELAYED_MESSAGE
        ));
        assert!(!is_opencode_free_tier_refusal_for_provider(
            None,
            403,
            RELAYED_MESSAGE
        ));
        assert!(!is_opencode_free_tier_refusal_for_provider(
            Some("opencode"),
            402,
            RELAYED_MESSAGE
        ));
    }

    #[test]
    fn geo_and_user_blocks_yield_to_a_fingerprint_rejection() {
        assert!(is_opencode_geo_blocked(403, GEO_BODY));
        assert!(is_opencode_geo_blocked(
            451,
            &GEO_BODY.replace("country", "region")
        ));
        assert!(!is_opencode_geo_blocked(403, FP_BODY));
        assert!(!is_opencode_geo_blocked(
            403,
            r#"{"error_code":1010,"message":"blocked"}"#
        ));
        assert!(is_opencode_geo_blocked(
            403,
            "retry after 1010 seconds, model is not available in your country"
        ));
        assert!(!is_opencode_geo_blocked(403, AUTH_BODY));
        assert!(!is_opencode_geo_blocked(429, GEO_BODY));
        assert!(!is_opencode_geo_blocked(200, GEO_BODY));
        assert!(!is_opencode_geo_blocked(403, "Region_error occurred"));
        assert!(!is_opencode_geo_blocked(403, "region-error occurred"));
        assert!(is_opencode_geo_blocked(403, "RegionError: refused"));
        assert!(!is_opencode_geo_blocked(403, "xregionerror"));

        assert!(is_opencode_user_blocked(403, BLOCKED_BODY));
        assert!(is_opencode_user_blocked(403, "[USER_BLOCKED] restricted"));
        assert!(is_opencode_user_blocked(451, BLOCKED_BODY));
        assert!(!is_opencode_user_blocked(451, AUTH_BODY));
        let geo = r#"{"error":{"type":"RegionError","message":"[user_blocked] not available in your country"}}"#;
        assert!(!is_opencode_user_blocked(403, geo));
        assert!(!is_opencode_user_blocked(451, geo));
        assert!(!is_opencode_user_blocked(
            403,
            r#"{"error_code":1010,"message":"[user_blocked] restricted"}"#
        ));
        assert!(is_opencode_user_blocked(
            403,
            "retry after 1010 seconds, [user_blocked] restricted"
        ));
        assert!(!is_opencode_user_blocked(
            403,
            "[user_blocked] browser_signature_banned"
        ));
        assert!(!is_opencode_user_blocked(
            403,
            "[user_blocked] fingerprint_rejection"
        ));
        assert!(!is_opencode_user_blocked(403, AUTH_BODY));
        for status in [200, 400, 401, 429, 500] {
            assert!(!is_opencode_user_blocked(status, BLOCKED_BODY));
        }
        assert!(!is_opencode_user_blocked(403, "user-blocked restricted"));
        assert!(!is_opencode_user_blocked(403, "user blocked restricted"));
        assert!(!is_opencode_user_blocked(403, ""));
    }
}
