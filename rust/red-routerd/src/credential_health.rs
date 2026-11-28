//! Background credential health sweep (legacy `src/lib/credentialHealth/`:
//! `scheduler.ts`, `cache.ts`, `probePolicy.ts`, and the probes of
//! `testSingleConnection` for the providers the daemon serves).
//!
//! Every active account is probed on a cadence (60 minutes by default,
//! `CREDENTIAL_HEALTH_CHECK_INTERVAL` in milliseconds). A failed probe is
//! retried after 5, 10, 30 minutes and then every 2 hours; a success resets
//! that. The latest result is kept in memory for 5 minutes, and while a
//! failure is fresh, combos skip the account (legacy `credentialGate`). A
//! failure also cools the connection down for 30 seconds, as the legacy
//! `rateLimitedUntil` write does.
use serde::Serialize;
use std::collections::HashMap;

/// Legacy `DEFAULT_SWEEP_INTERVAL_MS`.
pub(crate) const DEFAULT_SWEEP_INTERVAL_MS: u64 = 3_600_000;
/// Legacy `INITIAL_DELAY_MS`: the first sweep waits for the server to boot.
pub(crate) const INITIAL_DELAY_MS: u64 = 30_000;
/// Legacy `CONCURRENCY_LIMIT`.
pub(crate) const CONCURRENCY: usize = 5;
/// Legacy `BACKOFF_SCHEDULE`: 5 min, 10 min, 30 min, then 2 h.
pub(crate) const BACKOFF_MS: [u64; 4] = [300_000, 600_000, 1_800_000, 7_200_000];
/// Legacy cache TTL: a result older than this is unknown again.
pub(crate) const CACHE_TTL_MS: u64 = 5 * 60 * 1_000;
/// The connection cooldown a failed probe records (legacy `rateLimitedUntil`).
pub(crate) const FAILURE_COOLDOWN_MS: u64 = 30_000;
/// Legacy `validationRead` timeout for a GET probe.
pub(crate) const READ_TIMEOUT_MS: u64 = 8_000;
/// Legacy per-request test timeout of an OAuth probe.
pub(crate) const OAUTH_TIMEOUT_MS: u64 = 30_000;
const INCONCLUSIVE_RECHECK_MIN_MS: u64 = 30 * 60_000;
const INCONCLUSIVE_RECHECK_MULTIPLIER: u64 = 6;

/// Legacy `CREDENTIAL_HEALTH_CHECK_INTERVAL` (milliseconds, at least 10 s),
/// else the hourly default.
pub(crate) fn sweep_interval_ms(env: Option<&str>) -> u64 {
    env.and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value >= 10_000)
        .unwrap_or(DEFAULT_SWEEP_INTERVAL_MS)
}

/// Legacy `OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK`.
pub(crate) fn disabled(env: Option<&str>) -> bool {
    env.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

/// Legacy `resolveInconclusiveProbeRecheckDelayMs`.
/// Legacy `getConnIntervalMs`: an account's own cadence in minutes wins over
/// the global sweep cadence. The sweep leaves out an account set to 0.
pub(crate) fn account_interval_ms(minutes: Option<u32>, global_ms: u64) -> u64 {
    match minutes {
        Some(minutes) if minutes > 0 => u64::from(minutes) * 60_000,
        _ => global_ms,
    }
}

pub(crate) fn inconclusive_recheck_ms(interval_ms: u64) -> u64 {
    INCONCLUSIVE_RECHECK_MIN_MS.max(interval_ms.saturating_mul(INCONCLUSIVE_RECHECK_MULTIPLIER))
}

/// What one probe concluded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Probe {
    /// The credential works. A warning marks an inconclusive or degraded
    /// answer (rate limited, out of credits) that still proves the key.
    Valid { warning: Option<&'static str> },
    Invalid {
        error: String,
        /// Legacy `diagnosis.type`.
        kind: &'static str,
        status: Option<u16>,
    },
    /// No probe applies (legacy `skipped`): nothing is recorded.
    Skipped,
}

/// Legacy `classifyFailure` for a probe that got an HTTP status.
fn failure(status: u16, error: String) -> Probe {
    let kind = match status {
        401 | 403 => "upstream_auth_error",
        429 => "upstream_rate_limited",
        500..=599 => "upstream_unavailable",
        _ => "upstream_error",
    };
    Probe::Invalid {
        error,
        kind,
        status: Some(status),
    }
}

/// A probe that never got a status (legacy `network_error`).
pub(crate) fn network_failure(timed_out: bool) -> Probe {
    Probe::Invalid {
        error: if timed_out {
            "Connection test timed out".to_owned()
        } else {
            "Connection failed".to_owned()
        },
        kind: "network_error",
        status: None,
    }
}

/// The answer to `GET {base}/models` (or OpenRouter's `/auth/key`), legacy
/// `validateOpenAILikeProvider` / `validateOpenAICompatibleProvider`.
///
/// The legacy falls back to a one-token chat completion when the listing
/// answers anything else; that probe is not sent here (it spends tokens), so
/// those answers are skipped rather than recorded.
pub(crate) fn models_probe(status: u16) -> Probe {
    match status {
        200..=299 => Probe::Valid { warning: None },
        401 | 403 => failure(status, "Invalid API key".to_owned()),
        429 => Probe::Valid {
            warning: Some("Provider accepted the key but is rate limited (429)"),
        },
        402 => Probe::Valid {
            warning: Some("Provider accepted the key but reports no credits (402)"),
        },
        500..=599 => failure(status, format!("Provider unavailable ({status})")),
        _ => Probe::Skipped,
    }
}

/// The answer to the Codex probe (legacy `OAUTH_TEST_CONFIG.codex`: an empty
/// Responses request, where 400 proves the token).
pub(crate) fn codex_probe(status: u16, body: &str) -> Probe {
    match status {
        200..=299 | 400 => Probe::Valid { warning: None },
        401 | 403 if body.to_ascii_lowercase().contains("deactivated") => {
            failure(status, "Account deactivated by the provider".to_owned())
        }
        401 => failure(status, "Token invalid or revoked".to_owned()),
        403 => failure(status, "Access denied".to_owned()),
        _ => failure(status, format!("API returned {status}")),
    }
}

/// The Antigravity probe. The legacy sends a one-token `streamGenerateContent`;
/// here the account's quota RPC (`retrieveUserQuota`, which spends nothing)
/// proves the token instead. `outcome` is that request's result category.
pub(crate) fn agy_quota_probe(outcome: Result<(), &str>) -> Probe {
    match outcome {
        Ok(()) => Probe::Valid { warning: None },
        Err("authorization_failed") => failure(401, "Token invalid or revoked".to_owned()),
        Err("rate_limited") => Probe::Valid {
            warning: Some("Provider accepted the token but is rate limited (429)"),
        },
        Err("upstream_error") => failure(503, "Provider unavailable".to_owned()),
        Err("timeout") => network_failure(true),
        Err("unavailable") => network_failure(false),
        // A rejected or unreadable answer does not tell about the credential.
        Err(_) => Probe::Skipped,
    }
}

/// Legacy `checkExpiry` (Claude): no request, only the token's lifetime. An
/// account that can refresh is valid; an expired one that cannot is not.
pub(crate) fn expiry_probe(expires_at_unix: i64, now_unix: i64, can_refresh: bool) -> Probe {
    if expires_at_unix > 0 && expires_at_unix <= now_unix && !can_refresh {
        Probe::Invalid {
            error: "Token expired".to_owned(),
            kind: "token_expired",
            status: None,
        }
    } else {
        Probe::Valid { warning: None }
    }
}

/// The latest result of one account (legacy `CredentialHealthStatus`).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub(crate) struct Health {
    pub provider_id: String,
    pub provider: String,
    /// `active` or `error`.
    pub status: &'static str,
    pub last_error: Option<String>,
    pub error_type: Option<&'static str>,
    pub warning: Option<&'static str>,
    pub latency_ms: u64,
    pub checked_at_unix_ms: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Timing {
    failures: usize,
    next_attempt_unix_ms: u64,
}

/// Scheduler and cache state, in memory like the legacy.
#[derive(Default)]
pub(crate) struct State {
    health: HashMap<String, Health>,
    timing: HashMap<String, Timing>,
}

impl State {
    /// Whether an account is due: never tested since boot, or past its next
    /// attempt.
    pub(crate) fn due(&self, provider_id: &str, now_unix_ms: u64) -> bool {
        self.timing
            .get(provider_id)
            .is_none_or(|timing| now_unix_ms >= timing.next_attempt_unix_ms)
    }

    /// Record a probe and schedule the next one. Returns whether the probe
    /// failed. A skipped probe writes nothing and is due on the next sweep.
    pub(crate) fn record(
        &mut self,
        provider_id: &str,
        provider: &str,
        probe: &Probe,
        started_unix_ms: u64,
        latency_ms: u64,
        interval_ms: u64,
    ) -> bool {
        let now = started_unix_ms.saturating_add(latency_ms);
        match probe {
            Probe::Skipped => false,
            Probe::Valid { warning } => {
                let next = if warning
                    .is_some_and(|text| text.contains("credential validity is inconclusive"))
                {
                    now.saturating_add(inconclusive_recheck_ms(interval_ms))
                } else {
                    started_unix_ms.saturating_add(interval_ms)
                };
                self.timing.insert(
                    provider_id.to_owned(),
                    Timing {
                        failures: 0,
                        next_attempt_unix_ms: next,
                    },
                );
                self.put(Health {
                    provider_id: provider_id.to_owned(),
                    provider: provider.to_owned(),
                    status: "active",
                    last_error: None,
                    error_type: None,
                    warning: *warning,
                    latency_ms,
                    checked_at_unix_ms: now,
                });
                false
            }
            Probe::Invalid { error, kind, .. } => {
                let failures = self
                    .timing
                    .get(provider_id)
                    .map_or(0, |timing| timing.failures)
                    .saturating_add(1);
                let backoff = BACKOFF_MS[failures.min(BACKOFF_MS.len()) - 1];
                self.timing.insert(
                    provider_id.to_owned(),
                    Timing {
                        failures,
                        next_attempt_unix_ms: now.saturating_add(backoff),
                    },
                );
                self.put(Health {
                    provider_id: provider_id.to_owned(),
                    provider: provider.to_owned(),
                    status: "error",
                    last_error: Some(error.clone()),
                    error_type: Some(kind),
                    warning: None,
                    latency_ms,
                    checked_at_unix_ms: now,
                });
                true
            }
        }
    }

    fn put(&mut self, health: Health) {
        self.health.insert(health.provider_id.clone(), health);
    }

    /// Legacy `isCredentialHealthy`: `Some(true)` for a fresh success,
    /// `Some(false)` for a fresh failure, `None` when unknown or expired.
    pub(crate) fn healthy(&self, provider_id: &str, now_unix_ms: u64) -> Option<bool> {
        self.health
            .get(provider_id)
            .filter(|health| now_unix_ms.saturating_sub(health.checked_at_unix_ms) < CACHE_TTL_MS)
            .map(|health| health.status == "active")
    }

    /// Forget accounts that no longer exist.
    pub(crate) fn retain(&mut self, live: &std::collections::HashSet<String>) {
        self.health.retain(|id, _| live.contains(id));
        self.timing.retain(|id, _| live.contains(id));
    }

    /// Every account's latest result with its next check, by account id.
    pub(crate) fn view(&self, now_unix_ms: u64) -> Vec<HealthView> {
        let mut rows: Vec<HealthView> = self
            .health
            .values()
            .map(|health| {
                let timing = self
                    .timing
                    .get(&health.provider_id)
                    .copied()
                    .unwrap_or_default();
                HealthView {
                    health: health.clone(),
                    fresh: now_unix_ms.saturating_sub(health.checked_at_unix_ms) < CACHE_TTL_MS,
                    consecutive_failures: timing.failures,
                    next_check_at_unix_ms: timing.next_attempt_unix_ms,
                }
            })
            .collect();
        rows.sort_by(|left, right| left.health.provider_id.cmp(&right.health.provider_id));
        rows
    }
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct HealthView {
    #[serde(flatten)]
    pub health: Health,
    /// Within the 5-minute window in which combos act on it.
    pub fresh: bool,
    pub consecutive_failures: usize,
    pub next_check_at_unix_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cadence_follows_the_legacy_environment() {
        assert_eq!(sweep_interval_ms(None), 3_600_000);
        assert_eq!(account_interval_ms(None, 3_600_000), 3_600_000);
        assert_eq!(account_interval_ms(Some(15), 3_600_000), 900_000);
        assert_eq!(account_interval_ms(Some(1_440), 60_000), 86_400_000);
        assert_eq!(sweep_interval_ms(Some("60000")), 60_000);
        assert_eq!(sweep_interval_ms(Some("9999")), 3_600_000);
        assert_eq!(sweep_interval_ms(Some("soon")), 3_600_000);
        assert!(disabled(Some(" Yes ")));
        assert!(!disabled(Some("0")));
        assert!(!disabled(None));
        assert_eq!(inconclusive_recheck_ms(60_000), 30 * 60_000);
        assert_eq!(inconclusive_recheck_ms(3_600_000), 6 * 3_600_000);
    }

    #[test]
    fn probes_map_statuses_like_the_legacy_validators() {
        assert_eq!(models_probe(200), Probe::Valid { warning: None });
        assert!(matches!(
            models_probe(401),
            Probe::Invalid {
                kind: "upstream_auth_error",
                status: Some(401),
                ..
            }
        ));
        assert!(matches!(
            models_probe(429),
            Probe::Valid { warning: Some(_) }
        ));
        assert!(matches!(
            models_probe(402),
            Probe::Valid { warning: Some(_) }
        ));
        assert!(matches!(
            models_probe(503),
            Probe::Invalid {
                kind: "upstream_unavailable",
                ..
            }
        ));
        assert_eq!(models_probe(404), Probe::Skipped);
        assert_eq!(codex_probe(400, ""), Probe::Valid { warning: None });
        assert_eq!(
            codex_probe(401, "{}"),
            Probe::Invalid {
                error: "Token invalid or revoked".to_owned(),
                kind: "upstream_auth_error",
                status: Some(401)
            }
        );
        assert!(matches!(
            codex_probe(403, "account_deactivated"),
            Probe::Invalid { ref error, .. } if error == "Account deactivated by the provider"
        ));
        assert_eq!(expiry_probe(100, 200, true), Probe::Valid { warning: None });
        assert!(matches!(
            expiry_probe(100, 200, false),
            Probe::Invalid {
                kind: "token_expired",
                ..
            }
        ));
        assert_eq!(expiry_probe(0, 200, false), Probe::Valid { warning: None });
        assert_eq!(agy_quota_probe(Ok(())), Probe::Valid { warning: None });
        assert!(matches!(
            agy_quota_probe(Err("authorization_failed")),
            Probe::Invalid {
                kind: "upstream_auth_error",
                status: Some(401),
                ..
            }
        ));
        assert!(matches!(
            agy_quota_probe(Err("rate_limited")),
            Probe::Valid { warning: Some(_) }
        ));
        assert!(matches!(
            agy_quota_probe(Err("timeout")),
            Probe::Invalid {
                kind: "network_error",
                ..
            }
        ));
        assert_eq!(agy_quota_probe(Err("invalid_response")), Probe::Skipped);
    }

    #[test]
    fn failures_back_off_and_a_success_resets_them() {
        let mut state = State::default();
        assert!(state.due("a", 0));
        let bad = models_probe(401);
        let hour = DEFAULT_SWEEP_INTERVAL_MS;
        assert!(state.record("a", "openrouter", &bad, 1_000, 10, hour));
        assert!(!state.due("a", 1_010 + 299_999));
        assert!(state.due("a", 1_010 + 300_000));
        let mut at = 1_010 + 300_000;
        for backoff in [600_000, 1_800_000, 7_200_000, 7_200_000] {
            state.record("a", "openrouter", &bad, at, 0, hour);
            assert!(!state.due("a", at + backoff - 1));
            assert!(state.due("a", at + backoff));
            at += backoff;
        }
        let last = at - 7_200_000;
        assert_eq!(state.healthy("a", last + 1), Some(false));
        assert_eq!(state.healthy("a", last + CACHE_TTL_MS), None);
        assert!(!state.record(
            "a",
            "openrouter",
            &Probe::Valid { warning: None },
            at,
            5,
            hour
        ));
        assert_eq!(state.healthy("a", at + 5), Some(true));
        assert!(!state.due("a", at + hour - 1));
        assert!(state.due("a", at + hour));
        let view = state.view(at + 5);
        assert_eq!(view.len(), 1);
        assert_eq!(view[0].consecutive_failures, 0);
        assert_eq!(view[0].health.status, "active");
        // A skipped probe writes nothing.
        assert!(!state.record("b", "x", &Probe::Skipped, at, 0, hour));
        assert!(state.due("b", at));
        assert_eq!(state.healthy("b", at), None);
        state.retain(&std::collections::HashSet::new());
        assert!(state.view(at).is_empty());
    }
}
