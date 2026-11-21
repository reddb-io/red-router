//! Text-based quota exhaustion classifiers, ported from the legacy
//! `open-sse/services/quotaTextCooldowns.ts`: a subscription usage limit (5 h
//! windows), a weekly cap, a 5 h session cap and a rolling 24 h token cap, each
//! with the cooldown the account should serve instead of the short 429 backoff.

use crate::quota_reset_parsing::parse_day_granularity_reset_ms;

/// The cooldown a recognized quota text gets (legacy `QuotaTextFallback`); the
/// reason is always `quota_exhausted`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotaTextFallback {
    pub cooldown_ms: u64,
    pub used_upstream_retry_hint: Option<bool>,
    pub quota_reset_hint_ms: Option<u64>,
}

/// Legacy `SUBSCRIPTION_QUOTA_COOLDOWN_MS`: one hour, longer than the two
/// minutes of a payment-required cooldown, so accounts on one tier stop
/// cycling through tight retries.
pub const SUBSCRIPTION_QUOTA_COOLDOWN_MS: u64 = 60 * 60 * 1000;
const WEEKLY_QUOTA_COOLDOWN_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_WEEKLY_QUOTA_COOLDOWN_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const SESSION_QUOTA_COOLDOWN_MS: u64 = 5 * 60 * 60 * 1000;
const ROLLING_24H_QUOTA_COOLDOWN_MS: u64 = 24 * 60 * 60 * 1000;

/// Legacy `isSubscriptionQuotaText` (#2321): "usage limit reached" and its
/// siblings, over an already lowercased body. Native Claude's "this request
/// would exceed your account's rate limit" counts only for `claude`.
pub fn is_subscription_quota_text(lower: &str, provider: Option<&str>) -> bool {
    [
        "usage limit reached",
        "usage limit has been",
        "claude pro usage limit",
        "you've reached your usage limit",
        "you have reached your usage limit",
        "exceeds your plan",
        "plan limit",
        "plan's set usage limit",
        "plan limit exceeded",
        "usage limit exceeded",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || (provider == Some("claude")
            && lower.contains("this request would exceed your account's rate limit"))
}

/// Legacy `buildSubscriptionQuotaFallback`: the upstream retry hint when the
/// profile honors one, else a local hour. `upstream_hint_ms` and `body_hint_ms`
/// are what the caller's `getUpstreamRetryHint` and `parseRetryFromErrorText`
/// returned.
pub fn build_subscription_quota_fallback(
    error_text: &str,
    upstream_hint_ms: Option<u64>,
    body_hint_ms: Option<u64>,
    provider: Option<&str>,
) -> Option<QuotaTextFallback> {
    if !is_subscription_quota_text(&error_text.to_lowercase(), provider) {
        return None;
    }
    Some(QuotaTextFallback {
        cooldown_ms: upstream_hint_ms.unwrap_or(SUBSCRIPTION_QUOTA_COOLDOWN_MS),
        used_upstream_retry_hint: Some(upstream_hint_ms.is_some_and(|hint| hint != 0)),
        quota_reset_hint_ms: body_hint_ms,
    })
}

/// Legacy `isWeeklyUsageLimitText` (#3709): Ollama Cloud's weekly cap, in
/// wording any provider may share.
pub fn is_weekly_usage_limit_text(lower: &str) -> bool {
    [
        "weekly usage limit",
        "weekly limit reached",
        "reached your weekly",
        "1-week quota",
        "week quota",
        "weekly/monthly limit",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || (lower.contains("weekly") && lower.contains("quota") && lower.contains("exhaust"))
}

/// Legacy `buildWeeklyQuotaFallback`: the reset the body quotes (capped at 30
/// days), else a fixed day, since Ollama does not document its weekly anchor.
pub fn build_weekly_quota_fallback(
    error_text: &str,
    now_ms: i64,
    provider: Option<&str>,
) -> Option<QuotaTextFallback> {
    if !is_weekly_usage_limit_text(&error_text.to_lowercase()) {
        return None;
    }
    let parsed =
        parse_day_granularity_reset_ms(error_text, MAX_WEEKLY_QUOTA_COOLDOWN_MS, now_ms, provider)
            .filter(|ms| *ms > 0);
    Some(QuotaTextFallback {
        cooldown_ms: parsed.unwrap_or(WEEKLY_QUOTA_COOLDOWN_MS),
        used_upstream_retry_hint: Some(parsed.is_some()),
        quota_reset_hint_ms: parsed,
    })
}

/// Legacy `isSessionUsageLimitText` (#7071): a 5 hour session cap, scoped to
/// usage-limit wording so "session expired" auth errors do not match.
pub fn is_session_usage_limit_text(lower: &str) -> bool {
    lower.contains("session usage limit")
        || lower.contains("session limit reached")
        || (lower.contains("reached your session") && lower.contains("usage limit"))
}

/// Legacy `buildSessionQuotaFallback`: five hours.
pub fn build_session_quota_fallback(error_text: &str) -> Option<QuotaTextFallback> {
    is_session_usage_limit_text(&error_text.to_lowercase()).then_some(QuotaTextFallback {
        cooldown_ms: SESSION_QUOTA_COOLDOWN_MS,
        used_upstream_retry_hint: None,
        quota_reset_hint_ms: None,
    })
}

/// Legacy `isRolling24hUsageLimitText`: xAI Grok Build's free-tier per-model
/// rolling 24 hour token cap.
pub fn is_rolling_24h_usage_limit_text(lower: &str) -> bool {
    lower.contains("used all the included free usage")
        || (lower.contains("rolling 24-hour window") && lower.contains("tokens (actual/limit)"))
}

/// Legacy `buildRolling24hQuotaFallback`: a day, also as the reset hint.
pub fn build_rolling_24h_quota_fallback(error_text: &str) -> Option<QuotaTextFallback> {
    is_rolling_24h_usage_limit_text(&error_text.to_lowercase()).then_some(QuotaTextFallback {
        cooldown_ms: ROLLING_24H_QUOTA_COOLDOWN_MS,
        used_upstream_retry_hint: None,
        quota_reset_hint_ms: Some(ROLLING_24H_QUOTA_COOLDOWN_MS),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn fallback_json(found: Option<QuotaTextFallback>) -> Value {
        found.map_or(Value::Null, |found| {
            let mut out = json!({"shouldFallback": true, "cooldownMs": found.cooldown_ms, "reason": "quota_exhausted"});
            if let Some(used) = found.used_upstream_retry_hint {
                out["usedUpstreamRetryHint"] = json!(used);
            }
            if let Some(hint) = found.quota_reset_hint_ms {
                out["quotaResetHintMs"] = json!(hint);
            }
            out
        })
    }

    /// Outputs the legacy builders produced for the same inputs, with the clock
    /// fixed (`quota_text_cooldowns_oracle.json`, generated with Node).
    #[test]
    fn quota_text_fallbacks_match_the_legacy_implementation() {
        let oracle: Value =
            serde_json::from_str(include_str!("quota_text_cooldowns_oracle.json")).unwrap();
        let now = oracle["now"].as_i64().unwrap();
        for case in oracle["cases"].as_array().unwrap() {
            let text = case["text"].as_str().unwrap();
            let provider = case["provider"].as_str();
            assert_eq!(
                fallback_json(build_subscription_quota_fallback(
                    text,
                    case["hint"].as_u64(),
                    case["bodyHint"].as_u64(),
                    provider
                )),
                case["subscription"],
                "subscription {case}"
            );
            assert_eq!(
                fallback_json(build_weekly_quota_fallback(text, now, provider)),
                case["weekly"],
                "weekly {case}"
            );
            assert_eq!(
                fallback_json(build_session_quota_fallback(text)),
                case["session"],
                "session {case}"
            );
            assert_eq!(
                fallback_json(build_rolling_24h_quota_fallback(text)),
                case["rolling"],
                "rolling {case}"
            );
        }
    }
}
