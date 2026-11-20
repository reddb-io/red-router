//! Cooldown-aware request retry, ported from the legacy
//! `src/sse/services/cooldownAwareRetry.ts` and the `waitForCooldown`
//! resilience settings.
//!
//! When every connection of a direct provider route is cooling down, the
//! legacy chat handler waits for the earliest cooldown to end and selects
//! again, at most `max_retries` times, each wait at most `max_retry_wait_sec`
//! and all waits together within `budget_ms`. Combos skip it (the legacy
//! combo loop has its own wait), and an auth (401) cooldown is never waited
//! for: retrying sends the request into the same 401.

use serde::{Deserialize, Serialize};

/// Legacy `MAX_REQUEST_RETRY`.
pub(crate) const MAX_RETRIES: u32 = 10;
/// Legacy `MAX_RETRY_INTERVAL_SEC`.
pub(crate) const MAX_RETRY_WAIT_SEC: u32 = 300;
/// Legacy `MAX_BUDGET_MS`.
pub(crate) const MAX_BUDGET_MS: u64 = 5 * 60 * 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaitForCooldown {
    pub enabled: bool,
    pub max_retries: u32,
    pub max_retry_wait_sec: u32,
    pub budget_ms: u64,
}

impl Default for WaitForCooldown {
    /// The legacy effective default: the `requestRetry` (3) and
    /// `maxRetryIntervalSec` (30) settings defaults with the 5-minute budget.
    fn default() -> Self {
        Self {
            enabled: true,
            max_retries: 3,
            max_retry_wait_sec: 30,
            budget_ms: MAX_BUDGET_MS,
        }
    }
}

impl WaitForCooldown {
    /// The legacy `normalizeWaitForCooldownSettings` ranges; the budget is
    /// floored at one full wait.
    pub(crate) fn valid(&self) -> bool {
        self.max_retries <= MAX_RETRIES
            && self.max_retry_wait_sec <= MAX_RETRY_WAIT_SEC
            && self.budget_ms <= MAX_BUDGET_MS
            && self.budget_ms >= self.max_retry_wait_ms()
    }

    fn max_retry_wait_ms(&self) -> u64 {
        u64::from(self.max_retry_wait_sec) * 1_000
    }

    /// Legacy `getCooldownAwareRetryDecision`: how long to wait before
    /// selecting again, or `None` to answer with the cooldown now.
    pub(crate) fn wait_ms(
        &self,
        retry_after_ms: u64,
        attempt: u32,
        budget_left_ms: u64,
        last_status: Option<u16>,
    ) -> Option<u64> {
        if !self.enabled
            || self.max_retries == 0
            || self.max_retry_wait_sec == 0
            || attempt >= self.max_retries
            || last_status == Some(401)
        {
            return None;
        }
        (retry_after_ms <= self.max_retry_wait_ms() && retry_after_ms <= budget_left_ms)
            .then_some(retry_after_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_retry_decision_follows_the_legacy_limits() {
        let settings = WaitForCooldown::default();
        assert!(settings.valid());
        assert_eq!(
            settings.wait_ms(12_000, 0, MAX_BUDGET_MS, Some(429)),
            Some(12_000)
        );
        assert_eq!(settings.wait_ms(0, 2, MAX_BUDGET_MS, None), Some(0));
        // Attempts, a single wait and the remaining budget are all bounded.
        assert_eq!(settings.wait_ms(1_000, 3, MAX_BUDGET_MS, Some(429)), None);
        assert_eq!(settings.wait_ms(30_001, 0, MAX_BUDGET_MS, Some(429)), None);
        assert_eq!(settings.wait_ms(20_000, 1, 19_999, Some(429)), None);
        // An auth cooldown has no known end.
        assert_eq!(settings.wait_ms(1_000, 0, MAX_BUDGET_MS, Some(401)), None);
        for disabled in [
            WaitForCooldown {
                enabled: false,
                ..settings
            },
            WaitForCooldown {
                max_retries: 0,
                ..settings
            },
            WaitForCooldown {
                max_retry_wait_sec: 0,
                budget_ms: 0,
                ..settings
            },
        ] {
            assert!(disabled.valid());
            assert_eq!(disabled.wait_ms(0, 0, MAX_BUDGET_MS, None), None);
        }
        assert!(!WaitForCooldown {
            max_retries: 11,
            ..settings
        }
        .valid());
        assert!(!WaitForCooldown {
            budget_ms: 29_999,
            ..settings
        }
        .valid());
    }
}
