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
use std::collections::{HashMap, VecDeque};
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
    /// Legacy `globalConcurrentRequests`: requests in flight across every
    /// connection, whether or not the per-connection queue is on (zero is
    /// no cap).
    #[serde(default)]
    pub global_concurrent_requests: u32,
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
            global_concurrent_requests: 0,
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
            && self.global_concurrent_requests <= 100_000
    }

    /// The process-wide gate (legacy `acquireConcurrencyGates` "global"),
    /// when capped: concurrency only, with the queue's wait and depth.
    pub(crate) fn global_gate(&self) -> Option<Self> {
        (self.global_concurrent_requests > 0).then_some(Self {
            enabled: true,
            requests_per_minute: 1_000_000,
            min_time_between_requests_ms: 0,
            concurrent_requests: self.global_concurrent_requests.min(10_000),
            ..*self
        })
    }
}

/// Legacy `ProviderQuotaOverrideSettings`, by provider
/// (`providerQuotaOverrides`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderQuotaOverride {
    /// Replaces the provider's default sliding-window requests per minute.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rpm: Option<u32>,
    /// Replaces the provider's default per-connection concurrency cap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<u32>,
    /// A concurrency cap shared by every connection of the provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_concurrency: Option<u32>,
}

impl ProviderQuotaOverride {
    pub(crate) fn valid(&self) -> bool {
        self.rpm.is_none_or(|rpm| (1..=1_000_000).contains(&rpm))
            && self
                .concurrency
                .is_none_or(|count| (1..=10_000).contains(&count))
            && self
                .provider_concurrency
                .is_none_or(|count| count <= 100_000)
    }
}

/// Legacy `PROVIDER_DEFAULT_RATE_LIMITS` and `PROVIDER_DEFAULT_CONCURRENCY_CAP`.
const NVIDIA: &str = "nvidia";
const NVIDIA_DEFAULT_RPM: u32 = 40;
const NVIDIA_DEFAULT_CONCURRENCY: u32 = 6;
/// Legacy `NVIDIA_ACQUIRE_TIMEOUT_MS`.
const NVIDIA_ACQUIRE_TIMEOUT_MS: u64 = 30_000;

/// Every gate a request passes before its upstream call, in the legacy
/// order: the process-wide cap, the provider's shared cap
/// (`acquireConcurrencyGates`), the provider's default sliding window and
/// the connection's queue (`withRateLimit`), then the NVIDIA executor cap.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct AdmissionPlan {
    pub(crate) global: Option<RequestQueue>,
    pub(crate) provider_shared: Option<RequestQueue>,
    pub(crate) provider_rpm: Option<u32>,
    pub(crate) queue: Option<RequestQueue>,
    /// Whether the connection overrides the rate (a learned cap then only
    /// spends the window, legacy `hasRpmOverride`).
    pub(crate) queue_rpm_overridden: bool,
    pub(crate) connection_cap: Option<RequestQueue>,
}

/// The held slots of an admitted request.
#[derive(Default)]
pub(crate) struct Admission {
    slots: Vec<Slot>,
    /// The connection queue settings, for learning from the answer.
    pub(crate) queue: Option<RequestQueue>,
    pub(crate) rpm_overridden: bool,
}

fn concurrency_gate(concurrent: u32, max_wait_ms: u64, max_queue_depth: u32) -> RequestQueue {
    RequestQueue {
        enabled: true,
        requests_per_minute: 1_000_000,
        min_time_between_requests_ms: 0,
        concurrent_requests: concurrent.clamp(1, 10_000),
        max_wait_ms,
        max_queue_depth,
        global_concurrent_requests: 0,
    }
}

impl AdmissionPlan {
    pub(crate) fn new(
        global: &RequestQueue,
        provider: Option<&str>,
        provider_override: ProviderQuotaOverride,
        queue: Option<RequestQueue>,
    ) -> Self {
        let nvidia = provider == Some(NVIDIA);
        Self {
            global: global.global_gate(),
            provider_shared: provider_override
                .provider_concurrency
                .filter(|count| *count > 0)
                .map(|count| concurrency_gate(count, global.max_wait_ms, global.max_queue_depth)),
            // Legacy getProviderDefaultRateLimit: an rpm override applies to
            // any provider, the static default only to NVIDIA.
            provider_rpm: provider_override
                .rpm
                .or(nvidia.then_some(NVIDIA_DEFAULT_RPM)),
            queue,
            queue_rpm_overridden: false,
            connection_cap: nvidia.then(|| {
                concurrency_gate(
                    provider_override
                        .concurrency
                        .unwrap_or(NVIDIA_DEFAULT_CONCURRENCY),
                    NVIDIA_ACQUIRE_TIMEOUT_MS,
                    0,
                )
            }),
        }
    }

    /// Pass every gate, holding each slot until the upstream answers.
    pub(crate) async fn admit(
        self,
        connection: Option<&str>,
        provider: Option<&str>,
    ) -> Result<Admission, Rejection> {
        let mut admission = Admission::default();
        if let Some(gate) = self.global {
            admission
                .slots
                .push(limiter("\0global").acquire(&gate).await?);
        }
        if let (Some(gate), Some(provider)) = (self.provider_shared, provider) {
            admission.slots.push(
                limiter(&format!("\0provider:{provider}"))
                    .acquire(&gate)
                    .await?,
            );
        }
        if let (Some(settings), Some(connection)) = (self.queue, connection) {
            if let Some(rpm) = self.provider_rpm {
                await_provider_window(
                    &format!("{}:{connection}", provider.unwrap_or_default()),
                    rpm,
                    settings.max_wait_ms,
                )
                .await?;
            }
            admission
                .slots
                .push(limiter(connection).acquire(&settings).await?);
            admission.queue = Some(settings);
            admission.rpm_overridden = self.queue_rpm_overridden;
        }
        if let (Some(gate), Some(connection)) = (self.connection_cap, connection) {
            admission.slots.push(
                limiter(&format!("\0nvidia:{connection}"))
                    .acquire(&gate)
                    .await?,
            );
        }
        Ok(admission)
    }
}

static WINDOWS: LazyLock<Mutex<HashMap<String, VecDeque<u64>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Legacy `awaitProviderDefaultSlot`: a sliding one-minute window of
/// `requests`, waited for at most the queue budget and one window.
async fn await_provider_window(
    key: &str,
    requests: u32,
    max_wait_ms: u64,
) -> Result<(), Rejection> {
    let budget = if max_wait_ms == 0 {
        MINUTE_MS
    } else {
        max_wait_ms.min(MINUTE_MS)
    };
    let started = now_ms();
    loop {
        let now = now_ms();
        let wait = {
            let Ok(mut windows) = WINDOWS.lock() else {
                return Err(Rejection::QueueTimeout);
            };
            let window = windows.entry(key.to_owned()).or_default();
            while window.front().is_some_and(|at| at + MINUTE_MS <= now) {
                window.pop_front();
            }
            if window.len() < requests as usize {
                window.push_back(now);
                return Ok(());
            }
            window
                .front()
                .map_or(1, |oldest| (oldest + MINUTE_MS).saturating_sub(now).max(1))
        };
        let elapsed = now.saturating_sub(started);
        if elapsed >= budget {
            return Err(Rejection::QueueTimeout);
        }
        tokio::time::sleep(Duration::from_millis(wait.min(budget - elapsed))).await;
    }
}

/// Legacy per-connection `rateLimitProtection` and `rateLimitOverrides`:
/// protection queues the connection even when the auto-enable is off or it
/// is not an API-key account, and a positive override replaces the global
/// value (legacy `resolveOverride`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionQueuePolicy {
    #[serde(default)]
    pub protection: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requests_per_minute: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_time_between_requests_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrent_requests: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_wait_ms: Option<u64>,
}

impl ConnectionQueuePolicy {
    pub(crate) fn valid(&self) -> bool {
        self.requests_per_minute
            .is_none_or(|rpm| (1..=1_000_000).contains(&rpm))
            && self
                .min_time_between_requests_ms
                .is_none_or(|ms| (1..=60 * MINUTE_MS).contains(&ms))
            && self
                .concurrent_requests
                .is_none_or(|count| (1..=10_000).contains(&count))
            && self
                .max_wait_ms
                .is_none_or(|ms| (1..=24 * 60 * MINUTE_MS).contains(&ms))
    }
}

/// The queue a connection goes through, if any: the global queue for an
/// API-key account when it is on, or any protected connection, with the
/// connection's overrides applied.
pub(crate) fn effective(
    global: &RequestQueue,
    policy: Option<&ConnectionQueuePolicy>,
    api_key: bool,
) -> Option<RequestQueue> {
    let protected = policy.is_some_and(|policy| policy.protection);
    if !(protected || (global.enabled && api_key)) {
        return None;
    }
    let mut settings = RequestQueue {
        enabled: true,
        ..*global
    };
    if let Some(policy) = policy {
        if let Some(rpm) = policy.requests_per_minute {
            settings.requests_per_minute = rpm;
        }
        if let Some(ms) = policy.min_time_between_requests_ms {
            settings.min_time_between_requests_ms = ms;
        }
        if let Some(count) = policy.concurrent_requests {
            settings.concurrent_requests = count;
        }
        if let Some(ms) = policy.max_wait_ms {
            settings.max_wait_ms = ms;
        }
    }
    Some(settings)
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
    /// A cap stated in a 429 body (legacy `learnedLimits` `capRequests`).
    learned_cap: Option<crate::request_cap::RequestCap>,
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
        body: Option<&[u8]>,
        rpm_overridden: bool,
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
            state.learned_cap = None;
        }
        // A 429 starts the limiter over (the legacy limiter is evicted), then
        // a cap stated in its body, or one learned before, paces it (legacy
        // updateFromResponseBody and the learned-cap rebuild).
        if status == 429 {
            let learned = state.learned_cap;
            state.configure(settings);
            state.next_start_ms = 0;
            let stated = body.and_then(|body| {
                crate::request_cap::parse_request_cap_from_body(&String::from_utf8_lossy(body))
            });
            let Some(cap) = stated.or(learned) else {
                return;
            };
            let min_time = crate::request_cap::request_cap_min_time_ms(cap)
                .max(settings.min_time_between_requests_ms);
            // Legacy capSettingsWithinBudget: a cap the queue budget cannot
            // honour is left unlearned.
            if min_time > settings.max_wait_ms {
                state.learned_cap = learned;
                return;
            }
            state.learned_cap = Some(cap);
            let now = now_ms();
            if rpm_overridden {
                // The operator's rate keeps its pacing; the window is spent.
                if stated.is_some() {
                    state.reservoir = Some(Reservoir {
                        start_ms: now,
                        used: 0,
                        capacity: Some(0),
                        refill: settings.requests_per_minute,
                        interval_ms: MINUTE_MS,
                    });
                }
                return;
            }
            state.learned_min_time_ms = Some(min_time);
            // A stated cap means this window is spent; a remembered one
            // rebuilds the limiter full.
            state.reservoir = Some(Reservoir {
                start_ms: now,
                used: 0,
                capacity: Some(if stated.is_some() { 0 } else { cap.requests }),
                refill: cap.requests,
                interval_ms: cap.window_ms,
            });
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

    #[tokio::test]
    async fn provider_defaults_follow_the_legacy_tables() {
        let global = RequestQueue::default();
        let nvidia = AdmissionPlan::new(
            &global,
            Some("nvidia"),
            ProviderQuotaOverride::default(),
            None,
        );
        assert_eq!(nvidia.provider_rpm, Some(40));
        assert_eq!(
            nvidia.connection_cap.map(|gate| gate.concurrent_requests),
            Some(6)
        );
        assert_eq!(nvidia.provider_shared, None);
        let overridden = AdmissionPlan::new(
            &global,
            Some("groq"),
            ProviderQuotaOverride {
                rpm: Some(5),
                concurrency: Some(2),
                provider_concurrency: Some(3),
            },
            None,
        );
        // The concurrency override only feeds the NVIDIA executor cap.
        assert_eq!(
            (
                overridden.provider_rpm,
                overridden.connection_cap,
                overridden
                    .provider_shared
                    .map(|gate| gate.concurrent_requests)
            ),
            (Some(5), None, Some(3))
        );
        // The window admits its requests, then refuses within the budget.
        let key = "window-test:connection";
        for _ in 0..2 {
            assert_eq!(await_provider_window(key, 2, 50).await, Ok(()));
        }
        assert_eq!(
            await_provider_window(key, 2, 50).await,
            Err(Rejection::QueueTimeout)
        );
    }

    #[test]
    fn the_global_gate_caps_concurrency_only() {
        assert_eq!(RequestQueue::default().global_gate(), None);
        let gate = RequestQueue {
            global_concurrent_requests: 4,
            ..RequestQueue::default()
        }
        .global_gate()
        .unwrap();
        assert_eq!(
            (
                gate.concurrent_requests,
                gate.min_time_between_requests_ms,
                gate.max_wait_ms
            ),
            (4, 0, 30_000)
        );
    }

    #[test]
    fn connection_policies_enable_and_override_the_queue() {
        let global = RequestQueue::default();
        assert_eq!(effective(&global, None, true), None);
        let on = RequestQueue {
            enabled: true,
            ..global
        };
        assert_eq!(effective(&on, None, true), Some(on));
        // An OAuth account is only queued when protected.
        assert_eq!(effective(&on, None, false), None);
        let policy = ConnectionQueuePolicy {
            protection: true,
            requests_per_minute: Some(5),
            ..ConnectionQueuePolicy::default()
        };
        assert_eq!(
            effective(&global, Some(&policy), false),
            Some(RequestQueue {
                requests_per_minute: 5,
                ..on
            })
        );
        assert!(!ConnectionQueuePolicy {
            concurrent_requests: Some(0),
            ..policy
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
            None,
            false,
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
            None,
            false,
        );
        assert_eq!(state(&limiter), (Some(350), None));
        // Anthropic reads its own header names.
        limiter.learn_from_headers(
            Some("claude"),
            200,
            &headers(&[("anthropic-ratelimit-requests-limit", "50")]),
            &settings,
            None,
            false,
        );
        assert_eq!(state(&limiter).0, Some(1_190));
        limiter.learn_from_headers(
            Some("fireworks"),
            200,
            &headers(&[("x-ratelimit-over-limit", "yes")]),
            &settings,
            None,
            false,
        );
        assert_eq!(state(&limiter).0, Some(200));
        // A 429 restores the configured limiter.
        limiter.learn_from_headers(
            Some("openai"),
            429,
            &HeaderMap::new(),
            &settings,
            None,
            false,
        );
        assert_eq!(state(&limiter), (None, Some(Some(60))));
        // A cap stated in a 429 body spends the window and spreads the cap.
        let body = br#"{"error":{"message":"Maximum 5 requests within 1 minutes"}}"#;
        limiter.learn_from_headers(
            Some("openai"),
            429,
            &HeaderMap::new(),
            &settings,
            Some(body),
            false,
        );
        assert_eq!(state(&limiter), (Some(12_000), Some(Some(0))));
        // The next 429 rebuilds it from the learned cap, full.
        limiter.learn_from_headers(
            Some("openai"),
            429,
            &HeaderMap::new(),
            &settings,
            None,
            false,
        );
        assert_eq!(state(&limiter), (Some(12_000), Some(Some(5))));
        // A cap the wait budget cannot honour is not applied.
        let tight = RequestQueue {
            max_wait_ms: 1_000,
            ..settings
        };
        limiter.learn_from_headers(
            Some("openai"),
            429,
            &HeaderMap::new(),
            &tight,
            Some(body),
            false,
        );
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
