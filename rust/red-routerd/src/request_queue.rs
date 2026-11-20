//! The per-connection request queue, ported from the legacy
//! `open-sse/services/rateLimitManager.ts` (`withRateLimit`, its limiter
//! defaults and `updateFromHeaders`) for API-key connections.
//!
//! Each connection's requests start at least `min_time_between_requests_ms`
//! apart, at most `requests_per_minute` per minute and `concurrent_requests`
//! at a time; a request waits up to `max_wait_ms` for its turn (zero waits
//! without bound) and then fails locally with a 503, and with
//! `max_queue_depth` set a request that finds that many already waiting is
//! refused at once with a 429. A concurrency slot is held until the upstream
//! answers, as the legacy limiter wraps the executor call. Upstream rate
//! headers tune the limiter as the legacy one does: the request limit sets
//! the gap, a nearly spent allowance throttles to what remains until the
//! reset, plenty of headroom lifts the reservoir, and a 429 starts the
//! limiter over. The legacy limiter is on by default; the native one is off
//! unless configured, and the cutover imports the legacy settings. Limits
//! learned from 429 bodies and their persistence are not ported yet.

use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

const MINUTE_MS: u64 = 60_000;

/// Legacy `requestQueue` resilience settings (the ported subset).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestQueue {
    /// Legacy `autoEnableApiKeyProviders`.
    pub enabled: bool,
    pub requests_per_minute: u32,
    pub min_time_between_requests_ms: u64,
    pub concurrent_requests: u32,
    pub max_wait_ms: u64,
    pub max_queue_depth: u32,
}

impl Default for RequestQueue {
    fn default() -> Self {
        Self {
            enabled: false,
            requests_per_minute: 60,
            min_time_between_requests_ms: 350,
            concurrent_requests: 6,
            max_wait_ms: 30_000,
            max_queue_depth: 0,
        }
    }
}

impl RequestQueue {
    /// The legacy `normalizeRequestQueueSettings` ranges.
    pub(crate) fn valid(&self) -> bool {
        (1..=1_000_000).contains(&self.requests_per_minute)
            && self.min_time_between_requests_ms <= 60 * MINUTE_MS
            && (1..=10_000).contains(&self.concurrent_requests)
            && self.max_wait_ms <= 24 * 60 * MINUTE_MS
            && self.max_queue_depth <= 100_000
    }
}

/// Why the queue refused a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rejection {
    /// Legacy `RATE_LIMIT_QUEUE_FULL` (429).
    QueueFull,
    /// Legacy `RATE_LIMIT_QUEUE_TIMEOUT` (503).
    QueueTimeout,
}

/// Bottleneck's reservoir: `capacity` requests in the window that started
/// at `start_ms` (anchored on first use), refilled to `refill` every
/// `interval_ms`; no capacity means no reservoir.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Reservoir {
    start_ms: u64,
    used: u32,
    capacity: Option<u32>,
    refill: u32,
    interval_ms: u64,
}

impl Reservoir {
    fn per_minute(requests: u32) -> Self {
        Self {
            start_ms: 0,
            used: 0,
            capacity: Some(requests),
            refill: requests,
            interval_ms: MINUTE_MS,
        }
    }

    /// The earliest start at or after `at` within the reservoir, and the
    /// reservoir with that request counted.
    fn reserve(mut self, mut at: u64) -> (u64, Self) {
        let Some(mut capacity) = self.capacity else {
            return (at, self);
        };
        let interval = self.interval_ms.max(1);
        if self.start_ms == 0 {
            self.start_ms = at;
        }
        if at >= self.start_ms + interval {
            self.start_ms += (at - self.start_ms) / interval * interval;
            self.used = 0;
            capacity = self.refill;
        }
        if self.used >= capacity {
            self.start_ms += interval;
            self.used = 0;
            capacity = self.refill;
            at = at.max(self.start_ms);
        }
        self.used += 1;
        self.capacity = Some(capacity);
        (at, self)
    }
}

#[derive(Default)]
struct State {
    next_start_ms: u64,
    reservoir: Option<Reservoir>,
    /// A gap learned from upstream headers (legacy `updateLimiterSettings`).
    learned_min_time_ms: Option<u64>,
    in_flight: u32,
    queued: u32,
    /// The settings the limiter was configured for.
    settings: Option<RequestQueue>,
}

impl State {
    /// Legacy `buildLimiterDefaults`: the configured limiter, nothing learned.
    fn configure(&mut self, settings: &RequestQueue) {
        self.settings = Some(*settings);
        self.reservoir = Some(Reservoir::per_minute(settings.requests_per_minute));
        self.learned_min_time_ms = None;
    }

    fn min_time_ms(&self, settings: &RequestQueue) -> u64 {
        self.learned_min_time_ms
            .unwrap_or(settings.min_time_between_requests_ms)
    }
}

#[derive(Default)]
pub(crate) struct ConnectionLimiter {
    state: Mutex<State>,
    released: tokio::sync::Notify,
}

static LIMITERS: LazyLock<Mutex<HashMap<String, Arc<ConnectionLimiter>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The limiter of one connection.
pub(crate) fn limiter(connection: &str) -> Arc<ConnectionLimiter> {
    let Ok(mut limiters) = LIMITERS.lock() else {
        return Arc::default();
    };
    limiters.entry(connection.to_owned()).or_default().clone()
}

/// A held concurrency slot; dropping it lets the next request start.
pub(crate) struct Slot {
    limiter: Arc<ConnectionLimiter>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        if let Ok(mut state) = self.limiter.state.lock() {
            state.in_flight = state.in_flight.saturating_sub(1);
        }
        self.limiter.released.notify_one();
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Legacy `STANDARD_HEADERS` and `ANTHROPIC_HEADERS`: limit, remaining,
/// reset.
const STANDARD_HEADERS: [&str; 3] = [
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
];
const ANTHROPIC_HEADERS: [&str; 3] = [
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
];

/// JavaScript `parseInt`: the leading integer, if any.
fn parse_int(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (sign, digits) = match text.as_bytes().first() {
        Some(b'-') => (-1, &text[1..]),
        Some(b'+') => (1, &text[1..]),
        _ => (1, text),
    };
    let end = digits
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(digits.len());
    digits[..end].parse::<i64>().ok().map(|value| sign * value)
}

/// Legacy `parseResetTime`: a duration (`1m30s`, `500ms`), seconds or a Unix
/// timestamp, or a date, as milliseconds from now.
fn parse_reset_time(value: &str, now: u64) -> Option<u64> {
    static DURATION: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$")
            .expect("static pattern")
    });
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    if let Some(captures) = DURATION.captures(text) {
        let number = |index: usize| {
            captures
                .get(index)
                .and_then(|value| value.as_str().parse::<f64>().ok())
                .unwrap_or(0.0)
        };
        let total = (number(1) * 3_600.0 + number(2) * 60.0 + number(3)) * 1_000.0 + number(4);
        return Some(total.round() as u64);
    }
    if text
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte == b'.')
        && text.bytes().filter(|byte| *byte == b'.').count() <= 1
        && !text.starts_with('.')
        && !text.ends_with('.')
    {
        let seconds = text.parse::<f64>().ok().filter(|seconds| *seconds > 0.0)?;
        return Some(if seconds > 1_700_000_000.0 {
            ((seconds * 1_000.0) as u64).saturating_sub(now)
        } else {
            (seconds * 1_000.0) as u64
        });
    }
    let date = chrono::DateTime::parse_from_rfc3339(text)
        .or_else(|_| chrono::DateTime::parse_from_rfc2822(text))
        .ok()?;
    Some(
        u64::try_from(date.timestamp_millis())
            .unwrap_or(0)
            .saturating_sub(now),
    )
}

impl ConnectionLimiter {
    /// Legacy `withRateLimit`: wait for this request's turn and a free slot.
    pub(crate) async fn acquire(
        self: &Arc<Self>,
        settings: &RequestQueue,
    ) -> Result<Slot, Rejection> {
        let entered = now_ms();
        let unbounded = settings.max_wait_ms == 0;
        let deadline = entered.saturating_add(settings.max_wait_ms);
        let start_at = {
            let Ok(mut state) = self.state.lock() else {
                return Err(Rejection::QueueTimeout);
            };
            // Legacy updateAllLimiterSettings: new settings refill the
            // reservoir and replace what was learned, but keep the next start.
            if state.settings != Some(*settings) {
                state.configure(settings);
            }
            if settings.max_queue_depth > 0 && state.queued >= settings.max_queue_depth {
                return Err(Rejection::QueueFull);
            }
            let at = entered.max(state.next_start_ms);
            let (start_at, reservoir) = match state.reservoir {
                Some(reservoir) => {
                    let (start_at, reservoir) = reservoir.reserve(at);
                    (start_at, Some(reservoir))
                }
                None => (at, None),
            };
            if !unbounded && start_at > deadline {
                None
            } else {
                state.reservoir = reservoir;
                state.next_start_ms = start_at + state.min_time_ms(settings);
                state.queued += 1;
                Some(start_at)
            }
        };
        let Some(start_at) = start_at else {
            // Its turn falls past the budget: wait out the budget, as the
            // legacy queue does, then fail.
            tokio::time::sleep(Duration::from_millis(deadline - entered)).await;
            return Err(Rejection::QueueTimeout);
        };
        let leave_queue = |limiter: &Self| {
            if let Ok(mut state) = limiter.state.lock() {
                state.queued = state.queued.saturating_sub(1);
            }
        };
        tokio::time::sleep(Duration::from_millis(start_at.saturating_sub(entered))).await;
        loop {
            let released = self.released.notified();
            {
                let Ok(mut state) = self.state.lock() else {
                    return Err(Rejection::QueueTimeout);
                };
                if state.in_flight < settings.concurrent_requests {
                    state.in_flight += 1;
                    state.queued = state.queued.saturating_sub(1);
                    return Ok(Slot {
                        limiter: self.clone(),
                    });
                }
            }
            if unbounded {
                released.await;
                continue;
            }
            let remaining = deadline.saturating_sub(now_ms());
            if remaining == 0
                || tokio::time::timeout(Duration::from_millis(remaining), released)
                    .await
                    .is_err()
            {
                leave_queue(self);
                return Err(Rejection::QueueTimeout);
            }
        }
    }

    /// Legacy `updateFromHeaders`: tune the limiter from an upstream answer.
    pub(crate) fn learn_from_headers(
        &self,
        provider: Option<&str>,
        status: u16,
        headers: &HeaderMap,
        settings: &RequestQueue,
    ) {
        let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
        let [limit_name, remaining_name, reset_name] =
            if matches!(provider, Some("claude" | "anthropic")) {
                ANTHROPIC_HEADERS
            } else {
                STANDARD_HEADERS
            };
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.settings != Some(*settings) {
            state.configure(settings);
        }
        // A 429 starts the limiter over (the legacy limiter is evicted).
        if status == 429 {
            state.configure(settings);
            state.next_start_ms = 0;
            return;
        }
        // Fireworks' soft warning near capacity.
        if header("x-ratelimit-over-limit") == Some("yes") {
            state.learned_min_time_ms = Some(200);
            return;
        }
        let Some(limit) = header(limit_name)
            .and_then(parse_int)
            .filter(|limit| *limit > 0)
        else {
            return;
        };
        let now = now_ms();
        let reset_ms = header(reset_name)
            .and_then(|reset| parse_reset_time(reset, now))
            .filter(|reset| *reset > 0)
            .unwrap_or(MINUTE_MS);
        let mut min_time = (MINUTE_MS / limit.unsigned_abs()).saturating_sub(10);
        if let Some(remaining) = header(remaining_name).and_then(parse_int) {
            let limit_f = limit as f64;
            if (remaining as f64) < limit_f * 0.1 {
                state.reservoir = Some(Reservoir {
                    start_ms: now,
                    used: 0,
                    capacity: Some(u32::try_from(remaining.max(0)).unwrap_or(u32::MAX)),
                    refill: u32::try_from(limit).unwrap_or(u32::MAX),
                    interval_ms: reset_ms,
                });
            } else if (remaining as f64) > limit_f * 0.5 {
                min_time = settings.min_time_between_requests_ms;
                state.reservoir = None;
            }
        }
        state.learned_min_time_ms = Some(min_time);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> RequestQueue {
        RequestQueue {
            enabled: true,
            ..RequestQueue::default()
        }
    }

    #[test]
    fn requests_are_spaced_and_bounded_per_minute() {
        let mut reservoir = Reservoir::per_minute(2);
        let mut next = 0;
        let mut starts = Vec::new();
        for _ in 0..3 {
            let (at, after) = reservoir.reserve(next.max(1_000));
            reservoir = after;
            next = at + 100;
            starts.push(at);
        }
        // Two in the first minute, a hundred milliseconds apart; the third
        // waits for the reservoir to refill.
        assert_eq!(starts, [1_000, 1_100, 61_000]);
        assert!(RequestQueue::default().valid());
        assert!(!RequestQueue {
            concurrent_requests: 0,
            ..settings()
        }
        .valid());
    }

    #[test]
    fn reset_times_follow_the_legacy_parser() {
        let now = 1_800_000_000_000;
        assert_eq!(parse_reset_time("1m30s", now), Some(90_000));
        assert_eq!(parse_reset_time("2m59.56s", now), Some(179_560));
        assert_eq!(parse_reset_time("500ms", now), Some(500));
        assert_eq!(parse_reset_time("1h", now), Some(3_600_000));
        assert_eq!(parse_reset_time("12", now), Some(12_000));
        assert_eq!(parse_reset_time("1800000030", now), Some(30_000));
        assert_eq!(
            parse_reset_time("2027-01-15T08:00:05Z", 1_800_000_000_000),
            Some(
                u64::try_from(
                    chrono::DateTime::parse_from_rfc3339("2027-01-15T08:00:05Z")
                        .unwrap()
                        .timestamp_millis()
                )
                .unwrap()
                .saturating_sub(1_800_000_000_000)
            )
        );
        assert_eq!(parse_reset_time("soon", now), None);
        assert_eq!(parse_int("60 requests"), Some(60));
        assert_eq!(parse_int("x"), None);
    }

    #[test]
    fn upstream_headers_tune_the_limiter() {
        let limiter = ConnectionLimiter::default();
        let settings = settings();
        let headers = |pairs: &[(&'static str, &str)]| {
            let mut map = HeaderMap::new();
            for (name, value) in pairs {
                map.insert(*name, value.parse().unwrap());
            }
            map
        };
        let state = |limiter: &ConnectionLimiter| {
            let state = limiter.state.lock().unwrap();
            (
                state.learned_min_time_ms,
                state.reservoir.map(|r| r.capacity),
            )
        };
        // Low remaining: the gap follows the limit and the reservoir holds
        // what remains until the reset.
        limiter.learn_from_headers(
            Some("openai"),
            200,
            &headers(&[
                ("x-ratelimit-limit-requests", "100"),
                ("x-ratelimit-remaining-requests", "5"),
                ("x-ratelimit-reset-requests", "20s"),
            ]),
            &settings,
        );
        assert_eq!(state(&limiter), (Some(590), Some(Some(5))));
        // Plenty of headroom lifts the reservoir and keeps the configured gap.
        limiter.learn_from_headers(
            Some("openai"),
            200,
            &headers(&[
                ("x-ratelimit-limit-requests", "100"),
                ("x-ratelimit-remaining-requests", "90"),
            ]),
            &settings,
        );
        assert_eq!(state(&limiter), (Some(350), None));
        // Anthropic reads its own header names.
        limiter.learn_from_headers(
            Some("claude"),
            200,
            &headers(&[("anthropic-ratelimit-requests-limit", "50")]),
            &settings,
        );
        assert_eq!(state(&limiter).0, Some(1_190));
        limiter.learn_from_headers(
            Some("fireworks"),
            200,
            &headers(&[("x-ratelimit-over-limit", "yes")]),
            &settings,
        );
        assert_eq!(state(&limiter).0, Some(200));
        // A 429 restores the configured limiter.
        limiter.learn_from_headers(Some("openai"), 429, &HeaderMap::new(), &settings);
        assert_eq!(state(&limiter), (None, Some(Some(60))));
    }

    #[tokio::test]
    async fn the_queue_bounds_concurrency_wait_and_depth() {
        let limiter = Arc::new(ConnectionLimiter::default());
        let settings = RequestQueue {
            concurrent_requests: 1,
            min_time_between_requests_ms: 0,
            max_wait_ms: 50,
            ..settings()
        };
        let held = limiter.acquire(&settings).await.unwrap();
        // The only slot is taken: the next request waits out its budget.
        assert_eq!(
            limiter.acquire(&settings).await.err(),
            Some(Rejection::QueueTimeout)
        );
        drop(held);
        assert!(limiter.acquire(&settings).await.is_ok());

        let deep = RequestQueue {
            max_queue_depth: 1,
            max_wait_ms: 5_000,
            ..settings
        };
        let held = limiter.acquire(&deep).await.unwrap();
        let waiting = {
            let limiter = limiter.clone();
            tokio::spawn(async move { limiter.acquire(&deep).await.map(|_| ()) })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(
            limiter.acquire(&deep).await.err(),
            Some(Rejection::QueueFull)
        );
        drop(held);
        assert!(waiting.await.unwrap().is_ok());
    }
}
