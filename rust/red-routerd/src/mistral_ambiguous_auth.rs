//! Mistral's ambiguous 401, ported from the legacy
//! `open-sse/services/accountFallback/mistralAmbiguousAuth.ts`.
//!
//! Mistral answers a revoked key and an exhausted quota with the same bare
//! `401 {"detail":"Unauthorized"}`. By default, as in the legacy router, such
//! a 401 parks the connection as expired. With the legacy
//! `MISTRAL_AMBIGUOUS_401_SOFT_LOCKOUT` flag on, it cools the connection down
//! instead, at most [`MAX_SOFT_STRIKES`] times per [`STRIKE_WINDOW_MS`]
//! (counted by the connection's availability state); the next one parks it.

/// Legacy `MISTRAL_AMBIGUOUS_401_MAX_SOFT_STRIKES`.
pub(crate) const MAX_SOFT_STRIKES: u32 = 3;
/// Legacy `MISTRAL_AMBIGUOUS_401_STRIKE_WINDOW_MS`.
pub(crate) const STRIKE_WINDOW_MS: u64 = 60 * 60 * 1_000;

const AUTH_SIGNALS: &[&str] = &[
    "invalid api key",
    "token invalid",
    "revoked",
    "access denied",
];

/// Legacy `isMistralAmbiguous401`: a Mistral error body with no explicit auth
/// signal (callers check the status).
pub(crate) fn is_mistral_ambiguous_401(provider: Option<&str>, error_text: &str) -> bool {
    if provider != Some("mistral") {
        return false;
    }
    let normalized = error_text.to_lowercase();
    !AUTH_SIGNALS
        .iter()
        .any(|signal| normalized.contains(signal))
}

/// Whether the soft lockout is on: the legacy feature flag of the same name
/// (`true`, `1` or `yes`), read from the environment. Off by default.
pub(crate) fn soft_lockout_enabled() -> bool {
    std::env::var("MISTRAL_AMBIGUOUS_401_SOFT_LOCKOUT")
        .is_ok_and(|value| matches!(value.as_str(), "true" | "1" | "yes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_mistral_body_without_auth_signals_is_ambiguous() {
        assert!(is_mistral_ambiguous_401(
            Some("mistral"),
            r#"{"detail":"Unauthorized"}"#
        ));
        assert!(is_mistral_ambiguous_401(Some("mistral"), ""));
        assert!(is_mistral_ambiguous_401(
            Some("mistral"),
            "quota window closed"
        ));
        for body in [
            "Invalid API key",
            "Token invalid",
            "key REVOKED",
            "Access denied",
        ] {
            assert!(!is_mistral_ambiguous_401(Some("mistral"), body), "{body}");
        }
        assert!(!is_mistral_ambiguous_401(Some("openai"), "Unauthorized"));
        assert!(!is_mistral_ambiguous_401(None, "Unauthorized"));
        assert_eq!(MAX_SOFT_STRIKES, 3);
        assert_eq!(STRIKE_WINDOW_MS, 3_600_000);
    }
}
