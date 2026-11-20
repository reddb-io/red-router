//! The opt-in combo provider cooldown, ported from the legacy
//! `open-sse/services/providerCooldownTracker.ts` and its combo call sites
//! (`executeTargetAttempt.ts`, `executeTargetGates.ts`).
//!
//! With `providerCooldown.enabled`, every failed combo target puts its
//! provider connection in an in-memory cooldown that grows from
//! `min_retry_cooldown_ms`, doubling with each failure (at most ten times),
//! up to `max_retry_cooldown_ms`; combos skip the connection meanwhile and a
//! success resets it. Request-scoped failures do not count, nor a 500 or 429
//! from a provider whose quota is per model (sibling models may still work).
//! The state is process-local, like the legacy map.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// Legacy `DEFAULT_ENTRY_RETENTION_MS`.
const ENTRY_RETENTION_MS: u64 = 30 * 60 * 1_000;
const MAX_MIN_RETRY_COOLDOWN_MS: u64 = 60 * 60 * 1_000;
const MAX_MAX_RETRY_COOLDOWN_MS: u64 = 24 * 60 * 60 * 1_000;

/// Legacy `providerCooldown` resilience settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderCooldown {
    pub enabled: bool,
    pub min_retry_cooldown_ms: u64,
    pub max_retry_cooldown_ms: u64,
}

impl Default for ProviderCooldown {
    fn default() -> Self {
        Self {
            enabled: false,
            min_retry_cooldown_ms: 5_000,
            max_retry_cooldown_ms: 300_000,
        }
    }
}

impl ProviderCooldown {
    /// The legacy `normalizeProviderCooldownSettings` ranges.
    pub(crate) fn valid(&self) -> bool {
        self.min_retry_cooldown_ms <= MAX_MIN_RETRY_COOLDOWN_MS
            && self.max_retry_cooldown_ms >= self.min_retry_cooldown_ms
            && self.max_retry_cooldown_ms <= MAX_MAX_RETRY_COOLDOWN_MS
    }

    /// The legacy scaled cooldown after `failures` failures.
    fn cooldown_ms(&self, failures: u32) -> u64 {
        let exponent = failures.saturating_sub(1).min(10);
        self.min_retry_cooldown_ms
            .saturating_mul(1_u64 << exponent)
            .min(self.max_retry_cooldown_ms)
    }
}

struct Entry {
    last_failure_ms: u64,
    failures: u32,
    retention_ms: u64,
}

static TRACKER: LazyLock<Mutex<HashMap<(String, String), Entry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn key(provider: &str, connection: &str) -> (String, String) {
    (provider.to_owned(), connection.to_owned())
}

/// Legacy `recordProviderCooldown` for a connection.
pub(crate) fn record_failure(
    provider: &str,
    connection: &str,
    settings: &ProviderCooldown,
    now_ms: u64,
) {
    let Ok(mut tracker) = TRACKER.lock() else {
        return;
    };
    // Legacy cleanupExpiredCooldownEntries, run as entries are written.
    tracker.retain(|_, entry| now_ms.saturating_sub(entry.last_failure_ms) <= entry.retention_ms);
    let retention_ms = ENTRY_RETENTION_MS.max(settings.max_retry_cooldown_ms);
    let entry = tracker.entry(key(provider, connection)).or_insert(Entry {
        last_failure_ms: now_ms,
        failures: 0,
        retention_ms,
    });
    entry.last_failure_ms = now_ms;
    entry.failures = entry.failures.saturating_add(1);
    entry.retention_ms = entry.retention_ms.max(retention_ms);
}

/// Legacy `recordProviderSuccess`: the failure count starts over.
pub(crate) fn record_success(provider: &str, connection: &str) {
    if let Ok(mut tracker) = TRACKER.lock() {
        if let Some(entry) = tracker.get_mut(&key(provider, connection)) {
            entry.failures = 0;
        }
    }
}

/// Legacy `getRemainingCooldownMs` for a connection, when it is cooling down.
pub(crate) fn remaining_ms(
    provider: &str,
    connection: &str,
    settings: &ProviderCooldown,
    now_ms: u64,
) -> Option<u64> {
    let tracker = TRACKER.lock().ok()?;
    let entry = tracker.get(&key(provider, connection))?;
    if entry.failures == 0 {
        return None;
    }
    let elapsed = now_ms.saturating_sub(entry.last_failure_ms);
    settings
        .cooldown_ms(entry.failures)
        .checked_sub(elapsed)
        .filter(|remaining| *remaining > 0)
}

/// Legacy `REQUEST_SCOPED_UPSTREAM_ERROR_CODES` and the error types of
/// `isRequestScopedUpstreamFailure`, read from the body's `error` object.
fn request_scoped_upstream_failure(body: Option<&[u8]>) -> bool {
    let Some(error) = body
        .and_then(|body| serde_json::from_slice::<serde_json::Value>(body).ok())
        .and_then(|value| value.get("error").cloned())
        .filter(serde_json::Value::is_object)
    else {
        return false;
    };
    let field = |name: &str| match error.get(name) {
        Some(serde_json::Value::String(text)) => text.to_ascii_lowercase(),
        Some(serde_json::Value::Null) | None => String::new(),
        Some(other) => other.to_string().to_ascii_lowercase(),
    };
    let (code, kind) = (field("code"), field("type"));
    matches!(
        code.as_str(),
        "context_length_exceeded"
            | "context_window_exceeded"
            | "upstream_empty_response"
            | "upstream_response_failed"
            | "token_limit_exceeded"
            | "freetiererror"
    ) || matches!(
        kind.as_str(),
        "invalid_request_error" | "context_length_exceeded" | "freetiererror"
    )
}

/// Whether a failed combo target counts toward its provider cooldown.
pub(crate) fn counts_as_failure(
    provider: &str,
    status: u16,
    class: crate::resilience::ProviderFailureClass,
    body: Option<&[u8]>,
) -> bool {
    use crate::resilience::ProviderFailureClass;
    !matches!(
        class,
        ProviderFailureClass::RequestScoped | ProviderFailureClass::RequestRefusal
    ) && !request_scoped_upstream_failure(body)
        && !(matches!(status, 500 | 429)
            && crate::model_scope_providers::has_per_model_quota(provider))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resilience::ProviderFailureClass;

    #[test]
    fn the_cooldown_grows_with_failures_and_a_success_resets_it() {
        let settings = ProviderCooldown {
            enabled: true,
            ..ProviderCooldown::default()
        };
        assert!(settings.valid());
        let (provider, connection) = ("cooldown-test-provider", "cooldown-test-connection");
        assert_eq!(remaining_ms(provider, connection, &settings, 1_000), None);
        record_failure(provider, connection, &settings, 1_000);
        assert_eq!(
            remaining_ms(provider, connection, &settings, 1_000),
            Some(5_000)
        );
        assert_eq!(
            remaining_ms(provider, connection, &settings, 5_999),
            Some(1)
        );
        assert_eq!(remaining_ms(provider, connection, &settings, 6_000), None);
        record_failure(provider, connection, &settings, 10_000);
        assert_eq!(
            remaining_ms(provider, connection, &settings, 10_000),
            Some(10_000)
        );
        for at in 0..10 {
            record_failure(provider, connection, &settings, 20_000 + at);
        }
        // Capped at the maximum.
        assert_eq!(
            remaining_ms(provider, connection, &settings, 20_009),
            Some(300_000)
        );
        record_success(provider, connection);
        assert_eq!(remaining_ms(provider, connection, &settings, 20_009), None);
        assert!(!ProviderCooldown {
            min_retry_cooldown_ms: 10,
            max_retry_cooldown_ms: 9,
            enabled: true,
        }
        .valid());
    }

    #[test]
    fn request_scoped_and_per_model_failures_do_not_count() {
        let transient = ProviderFailureClass::Transient;
        assert!(counts_as_failure("openai", 500, transient, None));
        assert!(counts_as_failure("openai", 403, transient, Some(b"denied")));
        assert!(!counts_as_failure(
            "openai",
            404,
            ProviderFailureClass::RequestScoped,
            None
        ));
        assert!(!counts_as_failure(
            "opencode",
            403,
            ProviderFailureClass::RequestRefusal,
            None
        ));
        assert!(!counts_as_failure(
            "openai",
            400,
            transient,
            Some(br#"{"error":{"type":"invalid_request_error","message":"bad"}}"#)
        ));
        assert!(!counts_as_failure(
            "openai",
            400,
            transient,
            Some(br#"{"error":{"code":"context_length_exceeded"}}"#)
        ));
        assert!(counts_as_failure(
            "openai",
            400,
            transient,
            Some(br#"{"error":{"code":40001}}"#)
        ));
        assert!(!counts_as_failure("gemini", 429, transient, None));
        assert!(counts_as_failure("gemini", 403, transient, None));
    }
}
