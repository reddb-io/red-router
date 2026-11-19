//! Providers whose 402 is a shared account wallet, ported from the legacy
//! `open-sse/services/accountFallback/sharedWalletCredits.ts`.
//!
//! Grok Build (`grok-cli`), grok.com cookie sessions (`grok-web`) and xAI
//! OAuth (`xai-oauth`) bill every surface against one weekly pool. Their 402
//! empties the whole account, so it must never take the model-only lockout:
//! a combo of several model steps would otherwise park the empty account and
//! skip the remaining live accounts as "model locked".

/// Legacy `GROK_BUILD_USAGE_BALANCE_SIGNAL`.
pub(crate) const GROK_BUILD_USAGE_BALANCE_SIGNAL: &str = "usage balance exhausted";

const SHARED_WALLET_402_PROVIDERS: &[&str] = &["grok-cli", "grok-web", "xai-oauth"];

/// Legacy `matchesSharedWalletCreditsBody`; expects lowercased text.
pub(crate) fn matches_shared_wallet_credits_body(lowered_error_text: &str) -> bool {
    lowered_error_text.contains(GROK_BUILD_USAGE_BALANCE_SIGNAL)
}

/// Legacy `isSharedWalletCredits402`: a shared-wallet provider's 402 with an
/// empty body or the usage-balance signal. Provider ids match exactly.
pub(crate) fn is_shared_wallet_credits_402(
    provider: Option<&str>,
    status: u16,
    error_text: Option<&str>,
) -> bool {
    if status != 402 || !provider.is_some_and(|id| SHARED_WALLET_402_PROVIDERS.contains(&id)) {
        return false;
    }
    match error_text {
        None => true,
        Some(text) if text.trim().is_empty() => true,
        Some(text) => matches_shared_wallet_credits_body(&text.to_lowercase()),
    }
}

/// Legacy `isCreditsExhaustedWithSharedWallet`: any credit signal, or the
/// shared-wallet balance signal.
// The native classifier keeps its own credit list (which already carries the
// balance signal); this is the legacy helper's contract for future callers.
#[allow(dead_code)]
pub(crate) fn is_credits_exhausted_with_shared_wallet(error_text: &str, signals: &[&str]) -> bool {
    let lower = error_text.to_lowercase();
    signals.iter().any(|signal| lower.contains(signal))
        || matches_shared_wallet_credits_body(&lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_shared_wallet_providers_402_counts() {
        assert!(is_shared_wallet_credits_402(Some("grok-cli"), 402, None));
        assert!(is_shared_wallet_credits_402(
            Some("grok-web"),
            402,
            Some("  ")
        ));
        assert!(is_shared_wallet_credits_402(
            Some("xai-oauth"),
            402,
            Some("Usage balance EXHAUSTED for this week")
        ));
        assert!(!is_shared_wallet_credits_402(
            Some("xai-oauth"),
            402,
            Some("model not enabled")
        ));
        assert!(!is_shared_wallet_credits_402(Some("grok-cli"), 429, None));
        assert!(!is_shared_wallet_credits_402(Some("xai"), 402, None));
        assert!(!is_shared_wallet_credits_402(None, 402, None));
    }

    #[test]
    fn credit_signals_include_the_shared_wallet_balance() {
        assert!(is_credits_exhausted_with_shared_wallet(
            "Out of CREDITS",
            &["out of credits"]
        ));
        assert!(is_credits_exhausted_with_shared_wallet(
            "Usage balance exhausted",
            &[]
        ));
        assert!(!is_credits_exhausted_with_shared_wallet(
            "rate limited",
            &["out of credits"]
        ));
    }
}
