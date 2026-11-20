//! The per-connection request queue, ported from the legacy
//! `open-sse/services/rateLimitManager.ts` (`withRateLimit` and its limiter
//! defaults) for API-key connections.
//!
//! Each connection's requests start at least `min_time_between_requests_ms`
//! apart, at most `requests_per_minute` per minute and `concurrent_requests`
//! at a time; a request waits up to `max_wait_ms` for its turn (zero waits
//! without bound) and then fails locally with a 503, and with
//! `max_queue_depth` set a request that finds that many already waiting is
//! refused at once with a 429. A concurrency slot is held until the upstream
//! answers, as the legacy limiter wraps the executor call. The legacy
//! limiter is on by default; the native one is off unless configured, and
//! the cutover imports the legacy settings. Learned limits from upstream
//! headers and bodies are not ported yet.

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

#[derive(Default)]
struct State {
    next_start_ms: u64,
    window_start_ms: u64,
    window_count: u32,
    in_flight: u32,
    queued: u32,
    /// The settings the reservoir was filled for.
    settings: Option<RequestQueue>,
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

impl State {
    /// The start time the next request gets: spaced by the minimum gap and
    /// within the per-minute reservoir, which refills every minute.
    fn start_time(&self, now: u64, settings: &RequestQueue) -> (u64, u64, u32) {
        let mut window_start = self.window_start_ms;
        let mut count = self.window_count;
        let at = now.max(self.next_start_ms);
        if window_start == 0 || at >= window_start + MINUTE_MS {
            window_start = if window_start == 0 {
                at
            } else {
                window_start + (at - window_start) / MINUTE_MS * MINUTE_MS
            };
            count = 0;
        }
        if count >= settings.requests_per_minute {
            window_start += MINUTE_MS;
            count = 0;
            return (window_start.max(at), window_start, count);
        }
        (at, window_start, count)
    }
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
            // reservoir to the new per-minute amount.
            if state.settings != Some(*settings) {
                state.settings = Some(*settings);
                state.window_start_ms = 0;
                state.window_count = 0;
            }
            if settings.max_queue_depth > 0 && state.queued >= settings.max_queue_depth {
                return Err(Rejection::QueueFull);
            }
            let (start_at, window_start, count) = state.start_time(entered, settings);
            if !unbounded && start_at > deadline {
                None
            } else {
                state.window_start_ms = window_start;
                state.window_count = count + 1;
                state.next_start_ms = start_at + settings.min_time_between_requests_ms;
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
        let settings = RequestQueue {
            requests_per_minute: 2,
            min_time_between_requests_ms: 100,
            ..settings()
        };
        let mut state = State::default();
        let mut starts = Vec::new();
        for _ in 0..3 {
            let (at, window_start, count) = state.start_time(1_000, &settings);
            state.window_start_ms = window_start;
            state.window_count = count + 1;
            state.next_start_ms = at + settings.min_time_between_requests_ms;
            starts.push(at);
        }
        // Two in the first minute, a hundred milliseconds apart; the third
        // waits for the reservoir to refill.
        assert_eq!(starts, [1_000, 1_100, 61_000]);
        assert!(RequestQueue::default().valid());
        assert!(!RequestQueue {
            concurrent_requests: 0,
            ..settings
        }
        .valid());
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
