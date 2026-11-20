//! Echo targets for proxy egress probes, ported from the legacy
//! `src/lib/proxyEchoTarget.ts` (#9694).
//!
//! The IPv6-first target answers first for a proxy with IPv6 egress; an
//! IPv4-only tunnel has no route to it, so the IPv4 target is tried next,
//! inside the budget the caller already enforces.

use std::future::Future;

/// Legacy `EGRESS_ECHO_URL_DUAL`.
pub const EGRESS_ECHO_URL_DUAL: &str = "https://api64.ipify.org?format=json";
/// Legacy `EGRESS_ECHO_URL_V4`.
pub const EGRESS_ECHO_URL_V4: &str = "https://api4.ipify.org?format=json";
/// Legacy `EGRESS_ECHO_URL_ENV`.
pub const EGRESS_ECHO_URL_ENV: &str = "OMNIROUTE_PROXY_ECHO_URL";
/// Legacy `MIN_ECHO_ATTEMPT_MS`.
pub const MIN_ECHO_ATTEMPT_MS: u64 = 2_000;

/// Legacy `resolveEgressEchoUrls`: an operator override pins one target.
pub fn resolve_egress_echo_urls(override_url: Option<&str>) -> Vec<String> {
    match override_url.map(str::trim).filter(|url| !url.is_empty()) {
        Some(url) => vec![url.to_owned()],
        None => vec![
            EGRESS_ECHO_URL_DUAL.to_owned(),
            EGRESS_ECHO_URL_V4.to_owned(),
        ],
    }
}

/// Legacy `splitEchoAttemptBudget`: an even split, or the whole budget on the
/// first target when an even share would be too short to succeed.
pub fn split_echo_attempt_budget(total_ms: u64, attempts: usize) -> Vec<u64> {
    if total_ms == 0 || attempts == 0 {
        return Vec::new();
    }
    if attempts == 1 {
        return vec![total_ms];
    }
    let even = total_ms / attempts as u64;
    if even < MIN_ECHO_ATTEMPT_MS {
        return vec![total_ms];
    }
    vec![even; attempts]
}

/// Legacy `probeEchoTargets`: each target in order until one answers; the
/// last error when every target fails.
pub async fn probe_echo_targets<T, E, F, Fut>(
    mut run: F,
    total_ms: u64,
    override_url: Option<&str>,
) -> Result<(T, String), Option<E>>
where
    F: FnMut(String, u64) -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let urls = resolve_egress_echo_urls(override_url);
    let budgets = split_echo_attempt_budget(total_ms, urls.len());
    let mut last_error = None;
    for (url, budget) in urls.into_iter().zip(budgets) {
        match run(url.clone(), budget).await {
            Ok(result) => return Ok((result, url)),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Ported from tests/unit/proxy-echo-ipv4-fallback-9694.test.ts.
    #[test]
    fn targets_and_budgets_follow_the_legacy_order() {
        assert_eq!(
            resolve_egress_echo_urls(None),
            [EGRESS_ECHO_URL_DUAL, EGRESS_ECHO_URL_V4]
        );
        assert_eq!(
            resolve_egress_echo_urls(Some(" https://echo.internal/ip ")),
            ["https://echo.internal/ip"]
        );
        assert_eq!(resolve_egress_echo_urls(Some("  ")).len(), 2);
        assert_eq!(split_echo_attempt_budget(10_000, 2), [5_000, 5_000]);
        assert_eq!(split_echo_attempt_budget(6_000, 2), [3_000, 3_000]);
        assert_eq!(split_echo_attempt_budget(5_000, 2), [2_500, 2_500]);
        assert_eq!(
            split_echo_attempt_budget(MIN_ECHO_ATTEMPT_MS * 2 - 2, 2),
            [MIN_ECHO_ATTEMPT_MS * 2 - 2]
        );
        assert!(split_echo_attempt_budget(0, 2).is_empty());
        assert!(split_echo_attempt_budget(10_000, 0).is_empty());
        assert_eq!(split_echo_attempt_budget(10_000, 1), [10_000]);
    }

    #[tokio::test]
    async fn the_ipv4_target_is_tried_only_after_the_first_fails() {
        let tried = Mutex::new(Vec::new());
        let healthy = probe_echo_targets(
            |url: String, _| {
                tried.lock().unwrap().push(url);
                async { Ok::<_, &str>("{\"ip\":\"2001:db8::1\"}") }
            },
            10_000,
            None,
        )
        .await
        .unwrap();
        assert_eq!(healthy.1, EGRESS_ECHO_URL_DUAL);
        assert_eq!(tried.lock().unwrap().len(), 1);

        let ipv4 = probe_echo_targets(
            |url: String, budget| async move {
                assert_eq!(budget, 5_000);
                if url == EGRESS_ECHO_URL_DUAL {
                    Err("no route")
                } else {
                    Ok("{\"ip\":\"203.0.113.7\"}")
                }
            },
            10_000,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            ipv4,
            ("{\"ip\":\"203.0.113.7\"}", EGRESS_ECHO_URL_V4.to_owned())
        );

        let dead = probe_echo_targets(
            |url: String, _| async move { Err::<(), _>(url) },
            10_000,
            None,
        )
        .await;
        assert_eq!(dead, Err(Some(EGRESS_ECHO_URL_V4.to_owned())));

        let pinned = probe_echo_targets(
            |url: String, _| async move { Err::<(), _>(url) },
            10_000,
            Some("https://echo.internal/ip"),
        )
        .await;
        assert_eq!(pinned, Err(Some("https://echo.internal/ip".to_owned())));
    }
}
