//! RedRouter's Rust proxy and production-backend migration target.
pub mod accounting;
mod anthropic_stream;
mod availability;
mod circuit;
pub mod control_plane;
pub mod fastllm_control;
pub mod fastllm_plan;
pub mod fastllm_supervisor;
mod oidc;
mod policy;
pub mod product;
pub mod product_combo;
pub mod product_provider;
pub mod reconcile;
mod resilience;
pub mod shared_usage;
pub mod spa;
pub mod storage;
mod translation;
mod usage_stream;
use axum::{
    body::{to_bytes, Body},
    extract::{Path, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use futures_util::StreamExt;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{
        atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;

const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_IN_FLIGHT: usize = 64;
const MAX_ROUTE_TARGETS: usize = 8;
const NO_ROUTE_TARGET: usize = usize::MAX;
const HEADER_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct ProxyState {
    client: reqwest::Client,
    upstream: reqwest::Url,
    client_key: Arc<str>,
    provider_key: HeaderValue,
    permits: Arc<Semaphore>,
    routes: Arc<HashMap<String, Arc<ModelRoute>>>,
    clients: Arc<policy::ClientPolicies>,
    product_connection: Option<product::ProductConnection>,
    product_client_keys: bool,
    product_fallbacks: Arc<Vec<ProductFallback>>,
    product_combo: Option<product_combo::ProductCombo>,
    control_plane: Option<control_plane::ControlPlane>,
}

#[derive(Clone)]
pub(crate) struct LiveProvider {
    client: reqwest::Client,
    upstream: reqwest::Url,
    provider_key: HeaderValue,
    provider_id: Option<Arc<str>>,
    provider_name: Option<Arc<str>>,
    protocol: ProviderProtocol,
    rate_limit_scope: resilience::RateLimitScope,
    circuit: Option<Arc<circuit::ProviderCircuit>>,
    availability: Option<Arc<availability::ProviderAvailability>>,
    in_flight: Arc<AtomicUsize>,
}

struct ProductFallback {
    connection: product::ProductConnection,
    provider_key: HeaderValue,
}

pub(crate) struct ProviderLoadGuard {
    counter: Arc<AtomicUsize>,
}

impl ProviderLoadGuard {
    fn new(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::AcqRel);
        Self { counter }
    }
}

impl Drop for ProviderLoadGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Lock-free quota telemetry shared by every route snapshot for one provider.
/// The sequence counter gives readers a coherent multi-field view while the
/// dashboard updates the values without rebuilding routes or touching storage
/// on the request path.
pub(crate) struct TargetQuota {
    sequence: AtomicU64,
    session_remaining_ppm: AtomicI64,
    session_reset_unix_ms: AtomicI64,
    weekly_remaining_ppm: AtomicI64,
    weekly_reset_unix_ms: AtomicI64,
    limit_reached: AtomicU64,
    expires_at_unix_ms: AtomicI64,
}

#[derive(Clone, Copy)]
struct QuotaSnapshot {
    session_remaining_ppm: i64,
    session_reset_unix_ms: i64,
    weekly_remaining_ppm: i64,
    weekly_reset_unix_ms: i64,
    limit_reached: bool,
    expires_at_unix_ms: i64,
}

impl Default for TargetQuota {
    fn default() -> Self {
        Self {
            sequence: AtomicU64::new(0),
            session_remaining_ppm: AtomicI64::new(-1),
            session_reset_unix_ms: AtomicI64::new(0),
            weekly_remaining_ppm: AtomicI64::new(-1),
            weekly_reset_unix_ms: AtomicI64::new(0),
            limit_reached: AtomicU64::new(0),
            expires_at_unix_ms: AtomicI64::new(0),
        }
    }
}

impl TargetQuota {
    pub(crate) fn update(&self, quota: &storage::StoredProviderQuota) {
        self.sequence.fetch_add(1, Ordering::AcqRel);
        self.session_remaining_ppm
            .store(quota.session_remaining_ppm, Ordering::Relaxed);
        self.session_reset_unix_ms
            .store(quota.session_reset_unix_ms, Ordering::Relaxed);
        self.weekly_remaining_ppm
            .store(quota.weekly_remaining_ppm, Ordering::Relaxed);
        self.weekly_reset_unix_ms
            .store(quota.weekly_reset_unix_ms, Ordering::Relaxed);
        self.limit_reached
            .store(u64::from(quota.limit_reached), Ordering::Relaxed);
        self.expires_at_unix_ms
            .store(quota.expires_at_unix_ms, Ordering::Relaxed);
        self.sequence.fetch_add(1, Ordering::Release);
    }

    pub(crate) fn clear(&self) {
        self.sequence.fetch_add(1, Ordering::AcqRel);
        self.session_remaining_ppm.store(-1, Ordering::Relaxed);
        self.session_reset_unix_ms.store(0, Ordering::Relaxed);
        self.weekly_remaining_ppm.store(-1, Ordering::Relaxed);
        self.weekly_reset_unix_ms.store(0, Ordering::Relaxed);
        self.limit_reached.store(0, Ordering::Relaxed);
        self.expires_at_unix_ms.store(0, Ordering::Relaxed);
        self.sequence.fetch_add(1, Ordering::Release);
    }

    fn snapshot(&self, now_unix_ms: i64) -> Option<QuotaSnapshot> {
        loop {
            let before = self.sequence.load(Ordering::Acquire);
            if before & 1 == 1 {
                std::hint::spin_loop();
                continue;
            }
            let snapshot = QuotaSnapshot {
                session_remaining_ppm: self.session_remaining_ppm.load(Ordering::Relaxed),
                session_reset_unix_ms: self.session_reset_unix_ms.load(Ordering::Relaxed),
                weekly_remaining_ppm: self.weekly_remaining_ppm.load(Ordering::Relaxed),
                weekly_reset_unix_ms: self.weekly_reset_unix_ms.load(Ordering::Relaxed),
                limit_reached: self.limit_reached.load(Ordering::Relaxed) == 1,
                expires_at_unix_ms: self.expires_at_unix_ms.load(Ordering::Relaxed),
            };
            let after = self.sequence.load(Ordering::Acquire);
            if before == after {
                return (snapshot.expires_at_unix_ms > now_unix_ms).then_some(snapshot);
            }
        }
    }
}

pub(crate) struct ModelRoute {
    targets: Vec<ModelTarget>,
    protocol: ProviderProtocol,
    strategy: RouteStrategy,
    fallback: bool,
    cursor: AtomicUsize,
    seed: usize,
    last_good: AtomicUsize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RouteStrategy {
    Priority,
    RoundRobin,
    Weighted,
    Random,
    LeastUsed,
    P2c,
    FillFirst,
    StrictRandom,
    CostOptimized,
    ContextOptimized,
    ResetAware,
    ResetWindow,
    Headroom,
    QuotaWeighted,
    Lkgp,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderProtocol {
    OpenAi,
    OpenAiResponses,
    OpenAiEmbeddings,
    CohereRerank,
    Anthropic,
    OpenAiToAnthropic,
    Gemini,
}

pub(crate) struct ModelTarget {
    client: reqwest::Client,
    upstream: reqwest::Url,
    provider_key: HeaderValue,
    model: String,
    anthropic_bearer: bool,
    protocol: ProviderProtocol,
    product_connection: Option<product::ProductConnection>,
    product_model: Option<String>,
    provider_id: Option<Arc<str>>,
    provider_name: Option<Arc<str>>,
    rate_limit_scope: resilience::RateLimitScope,
    weight: u32,
    input_cost_per_million: Option<f64>,
    output_cost_per_million: Option<f64>,
    context_window_tokens: Option<u64>,
    quota: Option<Arc<TargetQuota>>,
    circuit: Option<Arc<circuit::ProviderCircuit>>,
    availability: Option<Arc<availability::ProviderAvailability>>,
    in_flight: Arc<AtomicUsize>,
}

impl ModelRoute {
    fn selection_start(&self, eligible: &[&ModelTarget]) -> usize {
        match self.strategy {
            RouteStrategy::Priority | RouteStrategy::FillFirst => 0,
            RouteStrategy::RoundRobin => {
                self.cursor.fetch_add(1, Ordering::Relaxed) % eligible.len()
            }
            RouteStrategy::Random => {
                pseudo_random(self.cursor.fetch_add(1, Ordering::Relaxed)) % eligible.len()
            }
            RouteStrategy::Weighted => {
                let total: usize = eligible.iter().map(|target| target.weight as usize).sum();
                let slot = pseudo_random(self.cursor.fetch_add(1, Ordering::Relaxed)) % total;
                let mut cumulative = 0;
                eligible
                    .iter()
                    .position(|target| {
                        cumulative += target.weight as usize;
                        slot < cumulative
                    })
                    .unwrap_or(0)
            }
            RouteStrategy::LeastUsed => {
                let minimum = eligible
                    .iter()
                    .map(|target| target.in_flight.load(Ordering::Acquire))
                    .min()
                    .unwrap_or(0);
                let tied = eligible
                    .iter()
                    .filter(|target| target.in_flight.load(Ordering::Acquire) == minimum)
                    .count();
                let selected = self.cursor.fetch_add(1, Ordering::Relaxed) % tied;
                eligible
                    .iter()
                    .enumerate()
                    .filter(|(_, target)| target.in_flight.load(Ordering::Acquire) == minimum)
                    .nth(selected)
                    .map(|(index, _)| index)
                    .unwrap_or(0)
            }
            RouteStrategy::P2c => {
                if eligible.len() == 1 {
                    return 0;
                }
                let sample = pseudo_random(self.cursor.fetch_add(1, Ordering::Relaxed));
                let first = sample % eligible.len();
                let mut second = pseudo_random(sample) % (eligible.len() - 1);
                if second >= first {
                    second += 1;
                }
                let first_load = eligible[first].in_flight.load(Ordering::Acquire);
                let second_load = eligible[second].in_flight.load(Ordering::Acquire);
                if second_load < first_load {
                    second
                } else {
                    first
                }
            }
            RouteStrategy::StrictRandom
            | RouteStrategy::CostOptimized
            | RouteStrategy::ContextOptimized
            | RouteStrategy::ResetAware
            | RouteStrategy::ResetWindow
            | RouteStrategy::Headroom
            | RouteStrategy::QuotaWeighted
            | RouteStrategy::Lkgp => {
                unreachable!("strategy uses an ordered attempt deck")
            }
        }
    }

    fn attempt_order(&self, eligible: &[&ModelTarget]) -> [usize; MAX_ROUTE_TARGETS] {
        if self.strategy == RouteStrategy::StrictRandom {
            return strict_random_order(
                eligible.len(),
                self.seed,
                self.cursor.fetch_add(1, Ordering::Relaxed),
            );
        }
        if self.strategy == RouteStrategy::Lkgp {
            let pinned = self
                .targets
                .get(self.last_good.load(Ordering::Acquire))
                .and_then(|target| {
                    eligible
                        .iter()
                        .position(|candidate| std::ptr::eq(*candidate, target))
                })
                .unwrap_or(0);
            let mut order = [0; MAX_ROUTE_TARGETS];
            order[0] = pinned;
            let mut output = 1;
            for index in 0..eligible.len() {
                if index != pinned {
                    order[output] = index;
                    output += 1;
                }
            }
            return order;
        }
        if self.strategy == RouteStrategy::QuotaWeighted {
            return self.quota_weighted_order(eligible);
        }
        if matches!(
            self.strategy,
            RouteStrategy::CostOptimized
                | RouteStrategy::ContextOptimized
                | RouteStrategy::ResetAware
                | RouteStrategy::ResetWindow
                | RouteStrategy::Headroom
        ) {
            let now_unix_ms = unix_time_ms();
            let mut order = [0; MAX_ROUTE_TARGETS];
            for (index, slot) in order.iter_mut().take(eligible.len()).enumerate() {
                *slot = index;
            }
            // At most eight targets are accepted. Insertion sort keeps ties in
            // dashboard order and avoids allocating on the request path.
            for index in 1..eligible.len() {
                let selected = order[index];
                let mut position = index;
                while position > 0
                    && self.target_precedes(
                        eligible[selected],
                        eligible[order[position - 1]],
                        now_unix_ms,
                    )
                {
                    order[position] = order[position - 1];
                    position -= 1;
                }
                order[position] = selected;
            }
            return order;
        }
        let start = self.selection_start(eligible);
        let mut order = [0; MAX_ROUTE_TARGETS];
        for (offset, slot) in order.iter_mut().take(eligible.len()).enumerate() {
            *slot = (start + offset) % eligible.len();
        }
        order
    }

    fn target_precedes(
        &self,
        candidate: &ModelTarget,
        current: &ModelTarget,
        now_unix_ms: i64,
    ) -> bool {
        match self.strategy {
            RouteStrategy::CostOptimized => {
                let candidate_cost = candidate.input_cost_per_million.unwrap_or(f64::INFINITY)
                    + candidate.output_cost_per_million.unwrap_or(f64::INFINITY);
                let current_cost = current.input_cost_per_million.unwrap_or(f64::INFINITY)
                    + current.output_cost_per_million.unwrap_or(f64::INFINITY);
                candidate_cost.total_cmp(&current_cost).is_lt()
            }
            RouteStrategy::ContextOptimized => {
                candidate.context_window_tokens.unwrap_or(0)
                    > current.context_window_tokens.unwrap_or(0)
            }
            RouteStrategy::ResetAware | RouteStrategy::QuotaWeighted => {
                quota_score(candidate, now_unix_ms) > quota_score(current, now_unix_ms)
            }
            RouteStrategy::ResetWindow => {
                quota_reset(candidate, now_unix_ms) < quota_reset(current, now_unix_ms)
            }
            RouteStrategy::Headroom => {
                quota_headroom(candidate, now_unix_ms) > quota_headroom(current, now_unix_ms)
            }
            _ => false,
        }
    }

    fn quota_weighted_order(&self, eligible: &[&ModelTarget]) -> [usize; MAX_ROUTE_TARGETS] {
        let now_unix_ms = unix_time_ms();
        let mut order = [0; MAX_ROUTE_TARGETS];
        let mut total = 0.0;
        let mut weights = [0.0; MAX_ROUTE_TARGETS];
        for (index, target) in eligible.iter().enumerate() {
            let headroom = quota_headroom(target, now_unix_ms);
            if headroom > 0.0 {
                let load = target.in_flight.load(Ordering::Acquire) as f64;
                weights[index] = quota_score(target, now_unix_ms).max(0.0) / (1.0 + load);
                total += weights[index];
            }
        }
        let sample = pseudo_random(self.cursor.fetch_add(1, Ordering::Relaxed));
        let winner = if total > 0.0 {
            let mut slot = (sample as f64 / (usize::MAX as f64 + 1.0)) * total;
            let mut selected = 0;
            for (index, weight) in weights.iter().take(eligible.len()).enumerate() {
                if *weight <= 0.0 {
                    continue;
                }
                selected = index;
                if slot < *weight {
                    break;
                }
                slot -= *weight;
            }
            selected
        } else {
            sample % eligible.len()
        };
        order[0] = winner;
        let mut output = 1;
        for index in 0..eligible.len() {
            if index != winner {
                order[output] = index;
                output += 1;
            }
        }
        // Fallbacks remain deterministic and prefer the strongest remaining
        // quota score after the weighted primary draw.
        for index in 2..eligible.len() {
            let selected = order[index];
            let mut position = index;
            while position > 1
                && quota_score(eligible[selected], now_unix_ms)
                    > quota_score(eligible[order[position - 1]], now_unix_ms)
            {
                order[position] = order[position - 1];
                position -= 1;
            }
            order[position] = selected;
        }
        order
    }

    fn set_last_good(&self, target: &ModelTarget) -> bool {
        if self.strategy != RouteStrategy::Lkgp {
            return false;
        }
        let Some(index) = self
            .targets
            .iter()
            .position(|candidate| std::ptr::eq(candidate, target))
        else {
            return false;
        };
        self.last_good.swap(index, Ordering::AcqRel) != index
    }

    fn clear_last_good(&self, target: &ModelTarget) -> bool {
        if self.strategy != RouteStrategy::Lkgp {
            return false;
        }
        let Some(index) = self
            .targets
            .iter()
            .position(|candidate| std::ptr::eq(candidate, target))
        else {
            return false;
        };
        self.last_good
            .compare_exchange(index, NO_ROUTE_TARGET, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    fn target_index(&self, provider_id: &str, model: &str) -> Option<usize> {
        self.targets.iter().position(|target| {
            target.provider_id.as_deref() == Some(provider_id) && target.model == model
        })
    }

    fn set_last_good_index(&self, index: usize) -> bool {
        self.strategy == RouteStrategy::Lkgp
            && index < self.targets.len()
            && self.last_good.swap(index, Ordering::AcqRel) != index
    }

    fn clear_last_good_index(&self, index: usize) -> bool {
        self.strategy == RouteStrategy::Lkgp
            && self
                .last_good
                .compare_exchange(index, NO_ROUTE_TARGET, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }

    fn clear_last_good_any(&self) {
        self.last_good.store(NO_ROUTE_TARGET, Ordering::Release);
    }
}

fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| i64::try_from(value.as_millis()).ok())
        .unwrap_or(i64::MAX)
}

fn retry_after_hint_ms(headers: &HeaderMap) -> Option<u64> {
    if let Some(seconds) = headers
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
    {
        return seconds.checked_mul(1_000);
    }
    let now = u64::try_from(unix_time_ms()).ok()?;
    [
        "x-ratelimit-reset",
        "x-ratelimit-reset-requests",
        "x-ratelimit-reset-tokens",
    ]
    .into_iter()
    .filter_map(|name| headers.get(name))
    .filter_map(|value| value.to_str().ok())
    .filter_map(|value| reset_hint_ms(value.trim(), now))
    .min()
}

fn reset_hint_ms(value: &str, now_unix_ms: u64) -> Option<u64> {
    if let Some(milliseconds) = value.strip_suffix("ms") {
        return milliseconds.trim().parse::<u64>().ok();
    }
    if let Some(seconds) = value.strip_suffix('s') {
        return seconds.trim().parse::<u64>().ok()?.checked_mul(1_000);
    }
    let value = value.parse::<u64>().ok()?;
    if value >= 1_000_000_000_000 {
        Some(value.saturating_sub(now_unix_ms))
    } else if value >= 1_000_000_000 {
        value
            .checked_mul(1_000)
            .map(|unix_ms| unix_ms.saturating_sub(now_unix_ms))
    } else {
        value.checked_mul(1_000)
    }
}

fn target_quota(target: &ModelTarget, now_unix_ms: i64) -> Option<QuotaSnapshot> {
    target.quota.as_ref()?.snapshot(now_unix_ms)
}

fn remaining_fraction(value: i64) -> Option<f64> {
    (0..=1_000_000)
        .contains(&value)
        .then_some(value as f64 / 1_000_000.0)
}

fn quota_window_score(
    remaining: f64,
    reset_at: i64,
    now_unix_ms: i64,
    window_ms: f64,
    rw: f64,
    pw: f64,
) -> f64 {
    let urgency = if reset_at <= 0 {
        0.5
    } else {
        (1.0 - (reset_at - now_unix_ms).max(0) as f64 / window_ms).clamp(0.0, 1.0)
    };
    rw * remaining + pw * urgency * (1.0 - remaining)
}

fn quota_score(target: &ModelTarget, now_unix_ms: i64) -> f64 {
    let Some(quota) = target_quota(target, now_unix_ms) else {
        return 0.5;
    };
    if quota.limit_reached {
        return f64::NEG_INFINITY;
    }
    let session = remaining_fraction(quota.session_remaining_ppm).unwrap_or(0.5);
    let weekly = remaining_fraction(quota.weekly_remaining_ppm).unwrap_or(0.5);
    let session_score = quota_window_score(
        session,
        quota.session_reset_unix_ms,
        now_unix_ms,
        5.0 * 60.0 * 60.0 * 1_000.0,
        0.45,
        0.55,
    );
    let weekly_score = quota_window_score(
        weekly,
        quota.weekly_reset_unix_ms,
        now_unix_ms,
        7.0 * 24.0 * 60.0 * 60.0 * 1_000.0,
        0.25,
        0.75,
    );
    let mut score = 0.35 * session_score + 0.65 * weekly_score;
    if session < 0.1 {
        score *= (session / 0.1).max(0.05);
    }
    score
}

fn quota_headroom(target: &ModelTarget, now_unix_ms: i64) -> f64 {
    let Some(quota) = target_quota(target, now_unix_ms) else {
        return 1.0;
    };
    if quota.limit_reached {
        return 0.0;
    }
    [
        remaining_fraction(quota.session_remaining_ppm),
        remaining_fraction(quota.weekly_remaining_ppm),
    ]
    .into_iter()
    .flatten()
    .reduce(f64::min)
    .unwrap_or(1.0)
}

fn quota_reset(target: &ModelTarget, now_unix_ms: i64) -> i64 {
    let Some(quota) = target_quota(target, now_unix_ms) else {
        return i64::MAX;
    };
    if quota.limit_reached {
        return i64::MAX;
    }
    // The legacy default is weekly. Providers without a weekly signal fall
    // back to their session window instead of becoming permanently unknown.
    let reset = if quota.weekly_reset_unix_ms > 0 {
        quota.weekly_reset_unix_ms
    } else {
        quota.session_reset_unix_ms
    };
    if reset > 0 {
        reset.max(now_unix_ms)
    } else {
        i64::MAX
    }
}

fn pseudo_random(counter: usize) -> usize {
    let mut value = (counter as u64).wrapping_add(0x9e3779b97f4a7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d049bb133111eb);
    (value ^ (value >> 31)) as usize
}

fn route_seed(value: &str) -> usize {
    value.bytes().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    }) as usize
}

fn secure_route_seed(value: &str) -> Result<usize, &'static str> {
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes).map_err(|_| "cannot seed strict-random route")?;
    Ok(route_seed(value) ^ u64::from_ne_bytes(bytes) as usize)
}

fn greatest_common_divisor(mut left: usize, mut right: usize) -> usize {
    while right != 0 {
        (left, right) = (right, left % right);
    }
    left
}

fn strict_random_order(
    target_count: usize,
    seed: usize,
    ticket: usize,
) -> [usize; MAX_ROUTE_TARGETS] {
    let mut order = [0; MAX_ROUTE_TARGETS];
    if target_count <= 1 {
        return order;
    }
    let cycle = ticket / target_count;
    let position = ticket % target_count;
    let mut step = 1 + pseudo_random(seed ^ target_count) % (target_count - 1);
    while greatest_common_divisor(step, target_count) != 1 {
        step = step % (target_count - 1) + 1;
    }
    let offset = pseudo_random(seed) % target_count;
    let rotation = if target_count == 2 {
        0
    } else {
        cycle % target_count
    };
    let primary = (offset + step * ((rotation + position) % target_count)) % target_count;

    for (index, slot) in order.iter_mut().take(target_count).enumerate() {
        *slot = index;
    }
    order.swap(0, primary);
    let mut random = pseudo_random(seed ^ ticket ^ 0xd1b54a32d192ed03_u64 as usize);
    for index in (2..target_count).rev() {
        random = pseudo_random(random);
        order.swap(index, 1 + random % index);
    }
    order
}

impl ProxyState {
    /// Set a process-wide capacity, independent of per-client quotas.
    pub fn with_max_in_flight(mut self, limit: usize) -> Result<Self, &'static str> {
        if limit == 0 || limit > Semaphore::MAX_PERMITS {
            return Err("invalid proxy concurrency capacity");
        }
        self.permits = Arc::new(Semaphore::new(limit));
        Ok(self)
    }

    /// Validate the exact dashboard combo and connections captured when this
    /// state was built. Used before a supervised engine may accept traffic.
    pub async fn product_configuration_unchanged(&self) -> bool {
        let Some(combo) = &self.product_combo else {
            return false;
        };
        let Some(route) = self.routes.get(combo.name()) else {
            return false;
        };
        if !self.product_client_keys || route.targets.is_empty() || !combo.unchanged().await {
            return false;
        }
        let mut checks = Vec::with_capacity(route.targets.len());
        for target in &route.targets {
            let Some(connection) = &target.product_connection else {
                return false;
            };
            checks.push(connection.unchanged());
        }
        futures_util::future::join_all(checks)
            .await
            .into_iter()
            .all(|valid| valid)
    }

    /// The operator configures one endpoint. DNS is resolved and pinned at startup.
    pub async fn new(
        upstream: &str,
        client_key: &str,
        provider_key: &str,
        allow_private: bool,
    ) -> Result<Self, &'static str> {
        Self::new_for_protocol(
            upstream,
            client_key,
            provider_key,
            allow_private,
            ProviderProtocol::OpenAi,
        )
        .await
    }

    async fn new_for_protocol(
        upstream: &str,
        client_key: &str,
        provider_key: &str,
        allow_private: bool,
        protocol: ProviderProtocol,
    ) -> Result<Self, &'static str> {
        let upstream = reqwest::Url::parse(upstream).map_err(|_| "invalid upstream URL")?;
        let loopback = match upstream.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        if !(upstream.scheme() == "https" || (upstream.scheme() == "http" && loopback))
            || !upstream.username().is_empty()
            || upstream.password().is_some()
            || upstream.query().is_some()
            || upstream.fragment().is_some()
            || !upstream.path().ends_with(match protocol {
                ProviderProtocol::OpenAi => "/chat/completions",
                ProviderProtocol::OpenAiResponses => "/responses",
                ProviderProtocol::OpenAiEmbeddings => "/embeddings",
                ProviderProtocol::CohereRerank => "/rerank",
                ProviderProtocol::Anthropic | ProviderProtocol::OpenAiToAnthropic => "/messages",
                ProviderProtocol::Gemini => "/models",
            })
        {
            return Err("upstream must be a credential-free HTTPS protocol endpoint (HTTP is allowed for literal loopback only)");
        }
        let host = upstream.host_str().ok_or("upstream host is missing")?;
        let bare_host = host.trim_matches(['[', ']']);
        if matches!(
            bare_host.to_ascii_lowercase().trim_end_matches('.'),
            "metadata.google.internal" | "metadata.goog"
        ) {
            return Err("metadata endpoints are not allowed");
        }
        let port = upstream
            .port_or_known_default()
            .ok_or("upstream port is missing")?;
        let addresses: Vec<_> = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::lookup_host((bare_host, port)),
        )
        .await
        .map_err(|_| "upstream DNS resolution timed out")?
        .map_err(|_| "upstream DNS resolution failed")?
        .collect();
        if addresses.is_empty()
            || addresses
                .iter()
                .any(|addr| !allowed_address(addr.ip(), allow_private || loopback))
        {
            return Err("upstream resolved to a forbidden address");
        }
        if !(16..=512).contains(&client_key.len()) || !(1..=512).contains(&provider_key.len()) {
            return Err("client key must be 16-512 bytes and provider key 1-512 bytes");
        }
        let provider_credential = match protocol {
            ProviderProtocol::OpenAi
            | ProviderProtocol::OpenAiResponses
            | ProviderProtocol::OpenAiEmbeddings
            | ProviderProtocol::CohereRerank => {
                format!("Bearer {provider_key}")
            }
            ProviderProtocol::Anthropic
            | ProviderProtocol::OpenAiToAnthropic
            | ProviderProtocol::Gemini => provider_key.to_owned(),
        };
        let mut provider_key =
            HeaderValue::from_str(&provider_credential).map_err(|_| "invalid provider key")?;
        provider_key.set_sensitive(true);
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(bare_host, &addresses)
            .connect_timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(16)
            .build()
            .map_err(|_| "could not initialize HTTP client")?;
        Ok(Self {
            client,
            upstream,
            client_key: Arc::from(client_key),
            provider_key,
            permits: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
            routes: Arc::new(HashMap::new()),
            clients: Arc::new(policy::ClientPolicies::single(client_key)),
            product_connection: None,
            product_client_keys: false,
            product_fallbacks: Arc::new(Vec::new()),
            product_combo: None,
            control_plane: None,
        })
    }

    /// Build the network-pinned runtime representation used by the Rust-owned
    /// control plane. Provider credentials never leave sensitive header storage.
    pub(crate) async fn live_provider(
        upstream: &str,
        provider_key: &str,
        allow_private: bool,
    ) -> Result<LiveProvider, &'static str> {
        let protocol = ProviderProtocol::from_upstream(upstream)?;
        let state = Self::new_for_protocol(
            upstream,
            "rust-control-plane-validation-key",
            provider_key,
            allow_private,
            protocol,
        )
        .await?;
        Ok(LiveProvider {
            client: state.client,
            upstream: state.upstream,
            provider_key: state.provider_key,
            provider_id: None,
            provider_name: None,
            protocol,
            rate_limit_scope: resilience::RateLimitScope::Auto,
            circuit: None,
            availability: None,
            in_flight: Arc::new(AtomicUsize::new(0)),
        })
    }

    pub(crate) fn control_target(
        provider: &LiveProvider,
        model: String,
        weight: u32,
        input_cost_per_million: Option<f64>,
        output_cost_per_million: Option<f64>,
        context_window_tokens: Option<u64>,
        quota: Arc<TargetQuota>,
    ) -> ModelTarget {
        ModelTarget {
            client: provider.client.clone(),
            upstream: provider.upstream.clone(),
            provider_key: provider.provider_key.clone(),
            model,
            anthropic_bearer: false,
            protocol: provider.protocol,
            product_connection: None,
            product_model: None,
            provider_id: provider.provider_id.clone(),
            provider_name: provider.provider_name.clone(),
            rate_limit_scope: provider.rate_limit_scope,
            weight,
            input_cost_per_million,
            output_cost_per_million,
            context_window_tokens,
            quota: Some(quota),
            circuit: provider.circuit.clone(),
            availability: provider.availability.clone(),
            in_flight: provider.in_flight.clone(),
        }
    }

    pub fn with_control_plane(mut self, control_plane: control_plane::ControlPlane) -> Self {
        self.control_plane = Some(control_plane);
        self
    }

    /// Fail closed when the selected product connection is edited or disabled.
    pub fn with_product_connection(mut self, connection: product::ProductConnection) -> Self {
        self.product_connection = Some(connection);
        self
    }

    pub fn with_product_client_keys(mut self) -> Result<Self, &'static str> {
        if self.product_connection.is_none() {
            return Err("product client keys require a product connection");
        }
        if !self.routes.is_empty() && self.product_combo.is_none() {
            return Err("product client keys cannot be combined with environment routes");
        }
        self.product_client_keys = true;
        Ok(self)
    }

    /// Bind a strictly parsed dashboard combo to individually guarded product
    /// connections. This must be called before enabling product client keys.
    pub fn with_product_combo(
        mut self,
        combo: product_combo::ProductCombo,
        connections: Vec<product::ProductConnection>,
    ) -> Result<Self, &'static str> {
        if self.product_client_keys
            || self.product_combo.is_some()
            || !self.product_fallbacks.is_empty()
            || self.routes.len() != 1
        {
            return Err("invalid product combo initialization");
        }
        let primary = self
            .product_connection
            .as_ref()
            .ok_or("product combo needs a connection")?;
        let routes = Arc::get_mut(&mut self.routes).ok_or("product combo state is shared")?;
        let route = routes
            .get_mut(combo.name())
            .ok_or("product combo route missing")?;
        let route = Arc::get_mut(route).ok_or("product combo route is shared")?;
        if route.protocol != ProviderProtocol::OpenAi
            || !route.fallback
            || route.strategy != RouteStrategy::Priority
            || route.targets.len() != combo.targets.len()
            || connections.len() != combo.targets.len()
        {
            return Err("invalid product combo route");
        }
        for ((target, source), connection) in route
            .targets
            .iter_mut()
            .zip(combo.targets.iter())
            .zip(connections)
        {
            let loopback = target
                .upstream
                .host_str()
                .and_then(|h| h.parse::<IpAddr>().ok())
                .is_some_and(|ip| ip.is_loopback());
            if !connection.same_database(primary)
                || target.protocol != ProviderProtocol::OpenAi
                || target.model != source.model
                || Some(connection.upstream_url()) != product_provider::chat_url(&source.provider)
                || (!loopback && target.upstream.as_str() != connection.upstream_url())
            {
                return Err("product combo target does not match stored configuration");
            }
            target.product_model = Some(source.full_model.clone());
            target.product_connection = Some(connection);
        }
        self.product_combo = Some(combo);
        Ok(self)
    }

    /// Configure same-provider product accounts for pre-stream fallback.
    pub fn with_product_fallbacks(
        mut self,
        fallbacks: Vec<(product::ProductConnection, String)>,
    ) -> Result<Self, &'static str> {
        let primary = self
            .product_connection
            .as_ref()
            .ok_or("product fallback requires a connection")?;
        if !self.product_client_keys || self.product_combo.is_some() || fallbacks.len() > 8 {
            return Err("product fallback requires product client keys and at most eight accounts");
        }
        let mut result = Vec::with_capacity(fallbacks.len());
        for (connection, key) in fallbacks {
            let key = zeroize::Zeroizing::new(key);
            if !connection.same_provider_database(primary) || !(1..=512).contains(&key.len()) {
                return Err("invalid product fallback");
            }
            let mut provider_key = HeaderValue::from_str(&format!("Bearer {}", key.as_str()))
                .map_err(|_| "invalid provider key")?;
            provider_key.set_sensitive(true);
            result.push(ProductFallback {
                connection,
                provider_key,
            });
        }
        self.product_fallbacks = Arc::new(result);
        Ok(self)
    }

    /// Replace the default client key with explicit per-key route policies.
    pub fn with_client_policies<F>(mut self, config: &str, resolve: F) -> Result<Self, &'static str>
    where
        F: Fn(&str) -> Option<String>,
    {
        self.clients = Arc::new(policy::ClientPolicies::parse(config, resolve)?);
        Ok(self)
    }

    /// Configure explicit OpenAI-compatible targets and bounded combo behavior.
    /// Credentials are resolved separately, never from JSON or request bodies.
    pub async fn with_routes<F>(
        mut self,
        config: &str,
        key: F,
        allow_private: bool,
    ) -> Result<Self, &'static str>
    where
        F: Fn(&str) -> Option<String>,
    {
        if self.product_client_keys {
            return Err("product client keys cannot be combined with environment routes");
        }
        let value: serde_json::Value =
            serde_json::from_str(config).map_err(|_| "invalid routes JSON")?;
        let entries = value.as_array().ok_or("routes must be an array")?;
        if entries.is_empty() || entries.len() > 64 {
            return Err("routes must contain 1-64 entries");
        }
        let mut routes = HashMap::new();
        for entry in entries {
            let object = entry.as_object().ok_or("invalid route")?;
            if object.keys().any(|k| {
                !["model", "protocol", "strategy", "fallback", "targets"].contains(&k.as_str())
            }) {
                return Err("unknown route field");
            }
            let alias = object
                .get("model")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .ok_or("invalid route model")?;
            let protocol = match object.get("protocol") {
                None => ProviderProtocol::OpenAi,
                Some(value) if value.as_str() == Some("openai") => ProviderProtocol::OpenAi,
                Some(value) if value.as_str() == Some("openai-responses") => {
                    ProviderProtocol::OpenAiResponses
                }
                Some(value) if value.as_str() == Some("openai-embeddings") => {
                    ProviderProtocol::OpenAiEmbeddings
                }
                Some(value) if value.as_str() == Some("cohere-rerank") => {
                    ProviderProtocol::CohereRerank
                }
                Some(value) if value.as_str() == Some("anthropic") => ProviderProtocol::Anthropic,
                Some(value) if value.as_str() == Some("openai-to-anthropic") => {
                    ProviderProtocol::OpenAiToAnthropic
                }
                Some(value) if value.as_str() == Some("gemini") => ProviderProtocol::Gemini,
                _ => return Err("unsupported route protocol"),
            };
            if protocol == ProviderProtocol::Gemini && !valid_gemini_model(alias) {
                return Err("invalid Gemini route model");
            }
            let strategy = match object.get("strategy") {
                None => RouteStrategy::Priority,
                Some(v) if v.as_str() == Some("priority") => RouteStrategy::Priority,
                Some(v) if v.as_str() == Some("round-robin") => RouteStrategy::RoundRobin,
                Some(v) if v.as_str() == Some("weighted") => RouteStrategy::Weighted,
                Some(v) if v.as_str() == Some("random") => RouteStrategy::Random,
                Some(v) if v.as_str() == Some("least-used") => RouteStrategy::LeastUsed,
                Some(v) if v.as_str() == Some("p2c") => RouteStrategy::P2c,
                Some(v) if v.as_str() == Some("fill-first") => RouteStrategy::FillFirst,
                Some(v) if v.as_str() == Some("strict-random") => RouteStrategy::StrictRandom,
                Some(v) if v.as_str() == Some("cost-optimized") => RouteStrategy::CostOptimized,
                Some(v) if v.as_str() == Some("context-optimized") => {
                    RouteStrategy::ContextOptimized
                }
                Some(v) if v.as_str() == Some("reset-aware") => RouteStrategy::ResetAware,
                Some(v) if v.as_str() == Some("reset-window") => RouteStrategy::ResetWindow,
                Some(v) if v.as_str() == Some("headroom") => RouteStrategy::Headroom,
                Some(v) if v.as_str() == Some("quota-weighted") => RouteStrategy::QuotaWeighted,
                Some(v) if v.as_str() == Some("lkgp") => RouteStrategy::Lkgp,
                _ => return Err("unsupported route strategy"),
            };
            let fallback = match object.get("fallback") {
                None => false,
                Some(v) => v.as_bool().ok_or("invalid fallback")?,
            };
            let entries = object
                .get("targets")
                .and_then(|v| v.as_array())
                .ok_or("route targets required")?;
            if entries.is_empty() || entries.len() > 8 {
                return Err("route targets must contain 1-8 entries");
            }
            let mut targets = Vec::new();
            for entry in entries {
                let target = entry.as_object().ok_or("invalid target")?;
                if target.keys().any(|k| {
                    ![
                        "url",
                        "model",
                        "api_key_env",
                        "auth",
                        "protocol",
                        "weight",
                        "input_cost_per_million",
                        "output_cost_per_million",
                        "context_window_tokens",
                    ]
                    .contains(&k.as_str())
                }) {
                    return Err("unknown target field");
                }
                let url = target
                    .get("url")
                    .and_then(|v| v.as_str())
                    .ok_or("target URL required")?;
                let model = target
                    .get("model")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty() && s.len() <= 256)
                    .ok_or("target model required")?;
                let target_protocol = match target.get("protocol") {
                    None => protocol,
                    Some(value)
                        if protocol == ProviderProtocol::OpenAi
                            && value.as_str() == Some("openai") =>
                    {
                        ProviderProtocol::OpenAi
                    }
                    Some(value)
                        if protocol == ProviderProtocol::OpenAi
                            && value.as_str() == Some("openai-to-anthropic") =>
                    {
                        ProviderProtocol::OpenAiToAnthropic
                    }
                    _ => return Err("unsupported target protocol for route"),
                };
                if protocol == ProviderProtocol::Gemini && !valid_gemini_model(model) {
                    return Err("invalid Gemini target model");
                }
                let key_name = target
                    .get("api_key_env")
                    .and_then(|v| v.as_str())
                    .filter(|s| {
                        !s.is_empty()
                            && s.len() <= 128
                            && s.bytes()
                                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                    })
                    .ok_or("invalid target key environment variable")?;
                let secret = key(key_name).ok_or("target provider key is missing")?;
                let weight = match target.get("weight") {
                    Some(value) if strategy == RouteStrategy::Weighted => value
                        .as_u64()
                        .and_then(|value| u32::try_from(value).ok())
                        .filter(|value| (1..=100).contains(value))
                        .ok_or("invalid target weight")?,
                    None if strategy == RouteStrategy::Weighted => {
                        return Err("weighted route targets require weights")
                    }
                    None => 1,
                    Some(_) => return Err("target weights require the weighted strategy"),
                };
                let target_cost = |field: &str| -> Result<Option<f64>, &'static str> {
                    target
                        .get(field)
                        .map(|value| {
                            value
                                .as_f64()
                                .filter(|value| {
                                    value.is_finite() && (0.0..=1_000_000.0).contains(value)
                                })
                                .ok_or("invalid target cost metadata")
                        })
                        .transpose()
                };
                let input_cost_per_million = target_cost("input_cost_per_million")?;
                let output_cost_per_million = target_cost("output_cost_per_million")?;
                let context_window_tokens = target
                    .get("context_window_tokens")
                    .map(|value| {
                        value
                            .as_u64()
                            .filter(|value| (1..=10_000_000).contains(value))
                            .ok_or("invalid target context metadata")
                    })
                    .transpose()?;
                if strategy == RouteStrategy::CostOptimized
                    && (input_cost_per_million.is_none() || output_cost_per_million.is_none())
                {
                    return Err("cost-optimized targets require input and output costs");
                }
                if strategy == RouteStrategy::ContextOptimized && context_window_tokens.is_none() {
                    return Err("context-optimized targets require context windows");
                }
                let anthropic_bearer = match target.get("auth") {
                    None => false,
                    Some(value)
                        if matches!(
                            target_protocol,
                            ProviderProtocol::Anthropic | ProviderProtocol::OpenAiToAnthropic
                        ) && value.as_str() == Some("x-api-key") =>
                    {
                        false
                    }
                    Some(value)
                        if matches!(
                            target_protocol,
                            ProviderProtocol::Anthropic | ProviderProtocol::OpenAiToAnthropic
                        ) && value.as_str() == Some("bearer") =>
                    {
                        true
                    }
                    _ => return Err("unsupported target authentication"),
                };
                let proxy = Self::new_for_protocol(
                    url,
                    &self.client_key,
                    &secret,
                    allow_private,
                    target_protocol,
                )
                .await?;
                let provider_key = if anthropic_bearer {
                    let mut value = HeaderValue::from_str(&format!("Bearer {secret}"))
                        .map_err(|_| "invalid provider key")?;
                    value.set_sensitive(true);
                    value
                } else {
                    proxy.provider_key
                };
                targets.push(ModelTarget {
                    client: proxy.client,
                    upstream: proxy.upstream,
                    provider_key,
                    model: model.to_string(),
                    anthropic_bearer,
                    protocol: target_protocol,
                    product_connection: None,
                    product_model: None,
                    provider_id: None,
                    provider_name: None,
                    rate_limit_scope: resilience::RateLimitScope::Auto,
                    weight,
                    input_cost_per_million,
                    output_cost_per_million,
                    context_window_tokens,
                    quota: None,
                    circuit: None,
                    availability: None,
                    in_flight: Arc::new(AtomicUsize::new(0)),
                });
            }
            if strategy == RouteStrategy::Weighted
                && targets.iter().map(|target| target.weight).sum::<u32>() != 100
            {
                return Err("weighted route target weights must total 100");
            }
            if routes
                .insert(
                    alias.to_string(),
                    Arc::new(ModelRoute {
                        targets,
                        protocol,
                        strategy,
                        fallback,
                        cursor: AtomicUsize::new(0),
                        seed: if strategy == RouteStrategy::StrictRandom {
                            secure_route_seed(alias)?
                        } else {
                            route_seed(alias)
                        },
                        last_good: AtomicUsize::new(NO_ROUTE_TARGET),
                    }),
                )
                .is_some()
            {
                return Err("duplicate route model");
            }
        }
        self.routes = Arc::new(routes);
        Ok(self)
    }
}

impl ProviderProtocol {
    pub(crate) fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "openai-responses" => Ok(Self::OpenAiResponses),
            "openai-embeddings" => Ok(Self::OpenAiEmbeddings),
            "cohere-rerank" => Ok(Self::CohereRerank),
            "anthropic" => Ok(Self::Anthropic),
            "gemini" => Ok(Self::Gemini),
            _ => Err("unsupported combo protocol"),
        }
    }

    pub(crate) fn from_upstream(upstream: &str) -> Result<Self, &'static str> {
        let parsed = reqwest::Url::parse(upstream).map_err(|_| "invalid upstream URL")?;
        let path = parsed.path().trim_end_matches('/');
        if path.ends_with("/chat/completions") {
            Ok(Self::OpenAi)
        } else if path.ends_with("/responses") {
            Ok(Self::OpenAiResponses)
        } else if path.ends_with("/embeddings") {
            Ok(Self::OpenAiEmbeddings)
        } else if path.ends_with("/rerank") {
            Ok(Self::CohereRerank)
        } else if path.ends_with("/messages") {
            Ok(Self::Anthropic)
        } else if path.ends_with("/models") {
            Ok(Self::Gemini)
        } else {
            Err("unsupported provider endpoint protocol")
        }
    }
}

// A model is a single URL path segment; never let route data change the
// pinned host, path hierarchy, query string, or requested operation.
fn valid_gemini_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 256
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && model != "."
        && model != ".."
}

pub(crate) fn allowed_address(ip: IpAddr, allow_private: bool) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            if ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_broadcast()
                || ip.is_link_local()
                || octets == [100, 100, 100, 200]
                || octets == [168, 63, 129, 16]
                || octets == [192, 0, 0, 192]
                || octets[0] == 0
                || octets[0] >= 224
            {
                return false;
            }
            let shared = octets[0] == 100 && (64..=127).contains(&octets[1]);
            let benchmark = octets[0] == 198 && (octets[1] == 18 || octets[1] == 19);
            let reserved = (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                || shared
                || benchmark
                || ip.is_documentation();
            !reserved && (allow_private || !(ip.is_private() || ip.is_loopback()))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return allowed_address(IpAddr::V4(v4), allow_private);
            }
            if ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unicast_link_local()
                || ip
                    == "fd00:ec2::254"
                        .parse::<std::net::Ipv6Addr>()
                        .expect("constant address")
            {
                return false;
            }
            if ip.is_loopback() || ip.is_unique_local() {
                return allow_private;
            }
            let segments = ip.segments();
            // Reject non-global forms, 6to4, and the documentation prefix.
            segments[0] & 0xe000 == 0x2000
                && segments[0] != 0x2002
                && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
        }
    }
}

pub fn router(state: ProxyState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { StatusCode::OK }))
        .route("/readyz", get(ready))
        .route("/api/auth/config", get(control_plane::auth_config))
        .route("/api/auth/oidc/login", get(control_plane::oidc_login))
        .route("/api/auth/oidc/callback", get(control_plane::oidc_callback))
        .route("/api/auth/logout", post(control_plane::oidc_logout))
        .route("/api/admin/providers", get(control_plane::list))
        .route(
            "/api/admin/oidc",
            get(control_plane::get_oidc)
                .put(control_plane::put_oidc)
                .delete(control_plane::delete_oidc),
        )
        .route(
            "/api/admin/oidc/discover",
            post(control_plane::discover_oidc),
        )
        .route(
            "/api/admin/providers/{id}",
            put(control_plane::put_provider).delete(control_plane::delete_provider),
        )
        .route(
            "/api/admin/client-keys",
            get(control_plane::list_client_keys),
        )
        .route(
            "/api/admin/client-keys/{id}",
            put(control_plane::put_client_key).delete(control_plane::delete_client_key),
        )
        .route("/api/admin/combos", get(control_plane::list_combos))
        .route(
            "/api/admin/combos/{id}",
            put(control_plane::put_combo).delete(control_plane::delete_combo),
        )
        .route(
            "/api/admin/combos/{id}/lkgp",
            axum::routing::delete(control_plane::delete_combo_route_pin),
        )
        .route(
            "/api/admin/provider-health",
            get(control_plane::list_provider_health),
        )
        .route(
            "/api/admin/provider-health/{id}",
            put(control_plane::put_provider_health).delete(control_plane::delete_provider_health),
        )
        .route(
            "/api/admin/provider-quotas",
            get(control_plane::list_provider_quotas),
        )
        .route(
            "/api/admin/provider-quotas/{id}",
            put(control_plane::put_provider_quota).delete(control_plane::delete_provider_quota),
        )
        .route("/v1/chat/completions", post(chat))
        .route("/v1/responses", post(responses))
        .route("/v1/embeddings", post(embeddings))
        .route("/v1/rerank", post(rerank))
        .route("/v1/messages", post(messages))
        .route("/v1beta/models/{model_action}", post(gemini))
        .with_state(state)
}

/// Attach a validated static dashboard build without putting Next.js on the
/// production request path. Explicit API and inference routes always win;
/// the SPA fallback also refuses reserved API namespaces.
pub fn router_with_spa(state: ProxyState, assets: spa::SpaAssets) -> Router {
    spa::attach(router(state), assets)
}

async fn ready(State(state): State<ProxyState>) -> StatusCode {
    match &state.control_plane {
        Some(control) if !control.ready().await => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::OK,
    }
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (
        status,
        Json(serde_json::json!({"error": {"message": message, "type": "proxy_error"}})),
    )
        .into_response()
}

fn circuit_open_error(retry_after_ms: u64) -> Response {
    let mut response = error(
        StatusCode::SERVICE_UNAVAILABLE,
        "All permitted provider circuits are open",
    );
    let seconds = retry_after_ms.div_ceil(1_000).max(1);
    if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

fn availability_blocked_error(
    retry_after_ms: u64,
    model_scope: bool,
    terminal_status: bool,
) -> Response {
    if terminal_status {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "All permitted provider connections require operator action",
        );
    }
    let message = if model_scope {
        "All permitted provider models are temporarily unavailable"
    } else {
        "All permitted provider connections are temporarily unavailable"
    };
    let mut response = error(StatusCode::SERVICE_UNAVAILABLE, message);
    let seconds = retry_after_ms.div_ceil(1_000).max(1);
    if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

async fn chat(State(state): State<ProxyState>, request: Request) -> Response {
    proxy_request(state, request, ProviderProtocol::OpenAi, None).await
}

async fn messages(State(state): State<ProxyState>, request: Request) -> Response {
    proxy_request(state, request, ProviderProtocol::Anthropic, None).await
}

async fn responses(State(state): State<ProxyState>, request: Request) -> Response {
    proxy_request(state, request, ProviderProtocol::OpenAiResponses, None).await
}

async fn embeddings(State(state): State<ProxyState>, request: Request) -> Response {
    proxy_request(state, request, ProviderProtocol::OpenAiEmbeddings, None).await
}

async fn rerank(State(state): State<ProxyState>, request: Request) -> Response {
    proxy_request(state, request, ProviderProtocol::CohereRerank, None).await
}

async fn gemini(
    State(state): State<ProxyState>,
    Path(model_action): Path<String>,
    request: Request,
) -> Response {
    let Some((model, action)) = model_action.split_once(':') else {
        return error(StatusCode::NOT_FOUND, "Unknown Gemini operation");
    };
    let stream = match action {
        "generateContent" => false,
        "streamGenerateContent" => true,
        _ => return error(StatusCode::NOT_FOUND, "Unknown Gemini operation"),
    };
    let query_allowed = match request.uri().query() {
        None => true,
        Some("alt=sse") => stream,
        Some(_) => false,
    };
    if !valid_gemini_model(model) || !query_allowed {
        return error(
            StatusCode::BAD_REQUEST,
            "Invalid Gemini request path or query",
        );
    }
    proxy_request(
        state,
        request,
        ProviderProtocol::Gemini,
        Some((model.to_owned(), stream)),
    )
    .await
}

async fn proxy_request(
    state: ProxyState,
    request: Request,
    protocol: ProviderProtocol,
    gemini: Option<(String, bool)>,
) -> Response {
    let mut selected_product = 0usize;
    let mut product_candidate = None;
    let original_headers = request.headers().clone();
    let product_access = if state.product_client_keys {
        let Some(candidate) = policy::extract_candidate(request.headers(), protocol) else {
            return error(StatusCode::UNAUTHORIZED, "Invalid API key");
        };
        let candidate = zeroize::Zeroizing::new(candidate.to_owned());
        let Some(primary) = &state.product_connection else {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Product policy unavailable",
            );
        };
        let mut selected = None;
        let choices = state
            .product_combo
            .as_ref()
            .and_then(|combo| state.routes.get(combo.name()))
            .map_or(1 + state.product_fallbacks.len(), |route| {
                route.targets.len()
            });
        for index in 0..choices {
            let connection = if let Some(combo) = &state.product_combo {
                let Some(connection) = state
                    .routes
                    .get(combo.name())
                    .and_then(|route| route.targets.get(index))
                    .and_then(|target| target.product_connection.as_ref())
                else {
                    continue;
                };
                if !connection.unchanged().await {
                    continue;
                }
                connection
            } else if index == 0 {
                primary
            } else {
                let connection = &state.product_fallbacks[index - 1].connection;
                if !connection.fallback_eligible().await {
                    continue;
                }
                connection
            };
            match connection
                .client_policies(&candidate, state.product_combo.as_ref().map(|c| c.name()))
                .await
            {
                Ok(Some(access)) => {
                    selected_product = index;
                    selected = Some(access);
                    break;
                }
                Ok(None) => continue,
                Err(_) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Product policy unavailable or unsupported",
                    )
                }
            }
        }
        product_candidate = Some(candidate);
        match selected {
            Some(access) => Some(access),
            None => return error(StatusCode::UNAUTHORIZED, "Invalid API key"),
        }
    } else {
        None
    };
    let control_clients = if product_access.is_none() {
        match &state.control_plane {
            Some(control) => match control.client_policies().await {
                Ok(policies) => policies,
                Err(_) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Client key policy unavailable",
                    )
                }
            },
            None => None,
        }
    } else {
        None
    };
    let clients = product_access.as_ref().map_or_else(
        || control_clients.as_deref().unwrap_or(state.clients.as_ref()),
        |access| &access.policies,
    );
    let Some(policy) = clients.authenticate(request.headers(), protocol) else {
        return error(StatusCode::UNAUTHORIZED, "Invalid API key");
    };
    let live_provider = match &state.control_plane {
        Some(control) => control.current().await,
        None => None,
    };
    let connection_changed = match (&state.product_connection, &state.product_combo) {
        (Some(connection), None) => !connection.unchanged().await,
        _ => false,
    };
    if connection_changed {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Product connection changed or is unavailable; restart required",
        );
    }
    if let Some(combo) = &state.product_combo {
        if !combo.unchanged().await {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Product combo changed or is unavailable; restart required",
            );
        }
    }
    let category = match protocol {
        ProviderProtocol::OpenAiEmbeddings => "embeddings",
        ProviderProtocol::CohereRerank => "rerank",
        _ => "chat",
    };
    if !policy.endpoint_allowed(category) {
        return error(StatusCode::FORBIDDEN, "Endpoint category is not allowed");
    }
    let anthropic_headers = if protocol == ProviderProtocol::Anthropic {
        let mut version = request.headers().get_all("anthropic-version").iter();
        let version_value = version
            .next()
            .cloned()
            .unwrap_or_else(|| HeaderValue::from_static("2023-06-01"));
        let mut beta = request.headers().get_all("anthropic-beta").iter();
        let beta_value = beta.next().cloned();
        if version.next().is_some()
            || beta.next().is_some()
            || version_value.is_empty()
            || version_value.len() > 128
            || beta_value
                .as_ref()
                .is_some_and(|v| v.is_empty() || v.len() > 512)
        {
            return error(StatusCode::BAD_REQUEST, "Invalid provider protocol headers");
        }
        Some((version_value, beta_value))
    } else {
        None
    };
    let permit = match state.permits.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return error(StatusCode::TOO_MANY_REQUESTS, "Proxy is at capacity"),
    };
    let client_permit = match policy.try_acquire() {
        Ok(permit) => permit,
        Err(()) => return error(StatusCode::TOO_MANY_REQUESTS, "Client is at capacity"),
    };
    let accept = request.headers().get(header::ACCEPT).cloned();
    let body = match to_bytes(request.into_body(), MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"),
    };
    let mut parsed: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid JSON request"),
    };
    let usage_accounting = state
        .product_connection
        .as_ref()
        .is_some_and(|c| c.usage_accounting_enabled());
    if usage_accounting && !state.product_client_keys {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Usage accounting requires product client keys",
        );
    }
    let accounting_stream = protocol == ProviderProtocol::OpenAi
        && parsed.get("stream").and_then(serde_json::Value::as_bool) == Some(true);
    if usage_accounting
        && (!matches!(
            protocol,
            ProviderProtocol::OpenAi | ProviderProtocol::OpenAiEmbeddings
        ) || (protocol == ProviderProtocol::OpenAi
            && (!matches!(
                parsed.get("stream"),
                None | Some(serde_json::Value::Bool(_))
            ) || (accounting_stream
                && parsed
                    .pointer("/stream_options/include_usage")
                    .and_then(serde_json::Value::as_bool)
                    != Some(true))))
            || (protocol == ProviderProtocol::OpenAiEmbeddings && parsed.get("stream").is_some())
            || parsed
                .get("service_tier")
                .is_some_and(|v| !v.is_null() && v.as_str() != Some("default")))
    {
        return error(
            StatusCode::BAD_REQUEST,
            "Usage accounting requires OpenAI chat or embeddings, the default tier, and include_usage for streaming",
        );
    }
    let model = gemini.as_ref().map(|(model, _)| model.clone()).or_else(|| {
        parsed
            .get("model")
            .and_then(|model| model.as_str())
            .filter(|model| !model.is_empty())
            .map(str::to_owned)
    });
    if protocol == ProviderProtocol::Gemini
        && (!parsed.is_object() || parsed.get("model").is_some())
    {
        return error(StatusCode::BAD_REQUEST, "Invalid Gemini request body");
    }
    let Some(model) = model else {
        return error(StatusCode::BAD_REQUEST, "A model is required");
    };
    let product_target = if let Some(combo) = &state.product_combo {
        if model != combo.name() {
            return error(StatusCode::NOT_FOUND, "Unknown product combo");
        }
        None
    } else if state.product_client_keys {
        let Some(primary) = &state.product_connection else {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Product policy unavailable",
            );
        };
        let connection = if selected_product == 0 {
            primary
        } else {
            &state.product_fallbacks[selected_product - 1].connection
        };
        match connection.direct_model(&model).await {
            Ok(Some(target)) => Some(target),
            Ok(None) => {
                return error(
                    StatusCode::FORBIDDEN,
                    "Model does not select the configured product provider or uses an unsupported route",
                )
            }
            Err(_) => {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Product routing policy unavailable",
                )
            }
        }
    } else {
        None
    };
    let direct_product_model = product_target.is_some();
    if state.product_combo.is_none() && !policy.route_allowed(&model) {
        return error(StatusCode::FORBIDDEN, "Model is not allowed");
    }
    let control_routes = if state.product_combo.is_none() && !state.product_client_keys {
        match &state.control_plane {
            Some(control) => match control.routes().await {
                Ok(routes) => routes,
                Err(_) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Combo routing policy unavailable",
                    )
                }
            },
            None => None,
        }
    } else {
        None
    };
    let control_routes_authoritative = control_routes.is_some();
    let route = control_routes
        .as_ref()
        .and_then(|routes| routes.get(&model))
        .or_else(|| state.routes.get(&model));
    if (route.is_none()
        && (control_routes_authoritative
            || !state.routes.is_empty()
            || (protocol != ProviderProtocol::OpenAi && !direct_product_model)))
        || route.is_some_and(|route| {
            route.protocol != protocol
                && !(protocol == ProviderProtocol::OpenAi
                    && route.protocol == ProviderProtocol::OpenAiToAnthropic)
        })
    {
        return error(StatusCode::NOT_FOUND, "Unknown model route");
    }
    let provider_id = if route.is_none() {
        live_provider
            .as_ref()
            .and_then(|provider| provider.provider_id.as_deref())
    } else {
        None
    };
    if route.is_none() && !policy.provider_allowed(provider_id) {
        return error(StatusCode::FORBIDDEN, "Provider connection is not allowed");
    }
    if route.is_none()
        && live_provider
            .as_ref()
            .is_some_and(|provider| provider.protocol != protocol)
    {
        return error(
            StatusCode::NOT_FOUND,
            "Provider does not support this protocol",
        );
    }
    let eligible: Vec<_> = route.map_or_else(Vec::new, |route| {
        route
            .targets
            .iter()
            .filter(|target| {
                policy.target_allowed(target.product_model.as_deref().unwrap_or(&target.model))
                    && policy.provider_allowed(target.provider_id.as_deref())
            })
            .collect()
    });
    if route.is_none() && !policy.target_allowed(&model) {
        return error(StatusCode::FORBIDDEN, "Model is not allowed");
    }
    if route.is_some() && eligible.is_empty() {
        return error(StatusCode::FORBIDDEN, "No permitted route target");
    }
    if let Some(target) = product_target {
        parsed["model"] = serde_json::Value::String(target);
    }
    // Validate translation before sending any attempt, so fallback cannot
    // silently discard fields that were accepted by a different provider.
    let translation_target = eligible
        .iter()
        .find(|target| target.protocol == ProviderProtocol::OpenAiToAnthropic);
    let mut translated = if let Some(target) = translation_target {
        match translation::request(&parsed, &target.model) {
            Ok(value) => Some(value),
            Err(_) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "Unsupported OpenAI request for Anthropic translation",
                )
            }
        }
    } else {
        None
    };
    if !policy.allow_request() {
        return error(StatusCode::TOO_MANY_REQUESTS, "Client rate limit exceeded");
    }
    if let (Some(access), Some(connection)) = (&product_access, &state.product_connection) {
        match connection.reserve_rpm(&access.key_id).await {
            Ok(true) => {}
            Ok(false) => return error(StatusCode::TOO_MANY_REQUESTS, "Client RPM quota exceeded"),
            Err(reason) => {
                eprintln!("product RPM accounting failed: {reason}");
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Client quota accounting unavailable",
                );
            }
        }
    }
    let attempt_order = route.map(|route| route.attempt_order(&eligible));
    let attempts = if state.product_combo.is_some() {
        eligible.len()
    } else if product_access.is_some() {
        1 + state.product_fallbacks.len() - selected_product
    } else {
        route.map_or(1, |route| if route.fallback { eligible.len() } else { 1 })
    };
    let mut final_response = None;
    let mut last_retry_response = None;
    let mut final_translated = false;
    let mut final_accounting = None;
    let mut final_load_guard = None;
    let mut last_retry_load_guard = None;
    let mut saw_open_circuit = false;
    let mut closest_circuit_retry_ms: Option<u64> = None;
    let mut saw_availability_block = false;
    let mut closest_availability_retry_ms: Option<u64> = None;
    let mut availability_model_scope = true;
    let mut saw_terminal_availability = false;
    if state.control_plane.is_some() && route.is_none() && live_provider.is_none() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "No active Rust provider configuration",
        );
    }
    for offset in 0..attempts {
        let product_index = selected_product + offset;
        if state.product_combo.is_none() && product_access.is_some() && offset > 0 {
            let Some(primary) = &state.product_connection else {
                break;
            };
            let fallback = &state.product_fallbacks[product_index - 1];
            let Some(candidate) = &product_candidate else {
                break;
            };
            if !primary.unchanged().await || !fallback.connection.fallback_eligible().await {
                continue;
            }
            let access = match fallback.connection.client_policies(candidate, None).await {
                Ok(Some(access)) => access,
                _ => continue,
            };
            let Some(rechecked) = access.policies.authenticate(&original_headers, protocol) else {
                continue;
            };
            if !rechecked.endpoint_allowed(category)
                || !rechecked.route_allowed(&model)
                || !rechecked.target_allowed(&model)
            {
                continue;
            }
        }
        let target = attempt_order.map(|order| eligible[order[offset]]);
        if let Some(combo) = &state.product_combo {
            let Some(target) = target else { break };
            let Some(connection) = &target.product_connection else {
                continue;
            };
            let Some(candidate) = &product_candidate else {
                break;
            };
            // These are independent read-only guards. Poll them concurrently,
            // while still requiring all of them before sending to the target.
            let (combo_ok, connection_ok, access) = tokio::join!(
                combo.unchanged(),
                connection.unchanged(),
                connection.client_policies(candidate, Some(combo.name()))
            );
            if !combo_ok || !connection_ok {
                continue;
            }
            let access = match access {
                Ok(Some(access)) => access,
                _ => continue,
            };
            let Some(rechecked) = access.policies.authenticate(&original_headers, protocol) else {
                continue;
            };
            if !rechecked.endpoint_allowed(category)
                || !rechecked
                    .target_allowed(target.product_model.as_deref().unwrap_or(&target.model))
            {
                continue;
            }
        }
        let target_model = target.map_or(model.as_str(), |target| target.model.as_str());
        let availability = target
            .and_then(|target| target.availability.as_ref())
            .or_else(|| {
                live_provider
                    .as_ref()
                    .and_then(|provider| provider.availability.as_ref())
            });
        let availability_permit = if let Some(availability) = availability {
            match availability.try_acquire(target_model).await {
                Ok(availability::AvailabilityDecision::Permit(permit)) => Some(permit),
                Ok(availability::AvailabilityDecision::Blocked {
                    retry_after_ms,
                    model_scope,
                    terminal_status,
                }) => {
                    if let Some(target) = target {
                        record_route_outcome(
                            &state,
                            route.map(|route| route.as_ref()),
                            target,
                            &model,
                            control_routes_authoritative,
                            false,
                        )
                        .await;
                    }
                    saw_availability_block = true;
                    availability_model_scope &= model_scope;
                    saw_terminal_availability |= terminal_status.is_some();
                    closest_availability_retry_ms = Some(
                        closest_availability_retry_ms
                            .map_or(retry_after_ms, |current| current.min(retry_after_ms)),
                    );
                    continue;
                }
                Err(_) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Provider availability accounting unavailable",
                    )
                }
            }
        } else {
            None
        };
        let accounting_attempt = if usage_accounting {
            let connection = if let Some(target) = target {
                target.product_connection.as_ref()
            } else if product_index > 0 {
                state
                    .product_fallbacks
                    .get(product_index - 1)
                    .map(|f| &f.connection)
            } else {
                state.product_connection.as_ref()
            };
            let Some(connection) = connection else {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Usage accounting unavailable",
                );
            };
            let target_model = target
                .map(|t| t.model.as_str())
                .or_else(|| parsed.get("model").and_then(serde_json::Value::as_str));
            let Some(target_model) = target_model else {
                return error(StatusCode::BAD_REQUEST, "A model is required");
            };
            let prices = match connection.usage_prices(target_model).await {
                Ok(prices) => Some(prices),
                Err(_) if connection.reports_all_usage() => None,
                Err(_) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Explicit model pricing unavailable",
                    )
                }
            };
            let Some(access) = &product_access else {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Usage accounting unavailable",
                );
            };
            let event_id = match connection
                .begin_usage(
                    &access.key_id,
                    target_model,
                    prices.as_ref(),
                    &access.usage_attributes,
                )
                .await
            {
                Ok(id) => id,
                Err("usage reservation denied") => {
                    return error(
                        StatusCode::TOO_MANY_REQUESTS,
                        "Client token or spend quota unavailable or exceeded",
                    )
                }
                Err(_) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Usage reservation unavailable",
                    )
                }
            };
            Some((
                connection.clone(),
                target_model.to_owned(),
                prices,
                event_id,
            ))
        } else {
            None
        };
        let translate_anthropic =
            target.is_some_and(|target| target.protocol == ProviderProtocol::OpenAiToAnthropic);
        let (client, url, provider_key, payload) = match target {
            Some(target) => {
                let encoded =
                    if let Some(value) = translated.as_mut().filter(|_| translate_anthropic) {
                        value["model"] = serde_json::Value::String(target.model.clone());
                        serde_json::to_vec(value)
                    } else {
                        if protocol != ProviderProtocol::Gemini {
                            parsed["model"] = serde_json::Value::String(target.model.clone());
                        }
                        serde_json::to_vec(&parsed)
                    };
                let payload = match encoded {
                    Ok(value) => value,
                    Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid JSON request"),
                };
                (
                    &target.client,
                    &target.upstream,
                    &target.provider_key,
                    payload,
                )
            }
            None => {
                let payload = if state.product_client_keys {
                    match serde_json::to_vec(&parsed) {
                        Ok(payload) => payload,
                        Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid JSON request"),
                    }
                } else {
                    body.to_vec()
                };
                if let Some(live) = &live_provider {
                    (&live.client, &live.upstream, &live.provider_key, payload)
                } else {
                    let provider_key = if product_access.is_some() && product_index > 0 {
                        &state.product_fallbacks[product_index - 1].provider_key
                    } else {
                        &state.provider_key
                    };
                    (&state.client, &state.upstream, provider_key, payload)
                }
            }
        };
        let mut target_url = url.clone();
        if direct_product_model && protocol == ProviderProtocol::OpenAiEmbeddings {
            let Some(prefix) = target_url.path().strip_suffix("/chat/completions") else {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Product provider does not expose a compatible embeddings endpoint",
                );
            };
            target_url.set_path(&format!("{prefix}/embeddings"));
        }
        if let (Some(target), Some((_, stream))) = (target, &gemini) {
            let action = if *stream {
                "streamGenerateContent"
            } else {
                "generateContent"
            };
            target_url.set_path(&format!("{}/{}:{action}", url.path(), target.model));
            if *stream {
                target_url.set_query(Some("alt=sse"));
            }
        }
        let mut upstream = client
            .post(target_url)
            .header(header::CONTENT_TYPE, "application/json")
            .body(payload);
        match &anthropic_headers {
            Some((version, beta)) => {
                upstream = if target.is_some_and(|target| target.anthropic_bearer) {
                    upstream.header(header::AUTHORIZATION, provider_key.clone())
                } else {
                    upstream.header("x-api-key", provider_key.clone())
                };
                upstream = upstream.header("anthropic-version", version.clone());
                if let Some(beta) = beta {
                    upstream = upstream.header("anthropic-beta", beta.clone());
                }
            }
            None if translate_anthropic => {
                upstream = if target.is_some_and(|target| target.anthropic_bearer) {
                    upstream.header(header::AUTHORIZATION, provider_key.clone())
                } else {
                    upstream.header("x-api-key", provider_key.clone())
                };
                upstream = upstream.header("anthropic-version", "2023-06-01");
            }
            None if protocol == ProviderProtocol::Gemini => {
                upstream = upstream.header("x-goog-api-key", provider_key.clone())
            }
            None => upstream = upstream.header(header::AUTHORIZATION, provider_key.clone()),
        }
        if let Some(accept) = &accept {
            upstream = upstream.header(header::ACCEPT, accept.clone());
        }
        let circuit = target
            .and_then(|target| target.circuit.as_ref())
            .or_else(|| {
                live_provider
                    .as_ref()
                    .and_then(|provider| provider.circuit.as_ref())
            });
        let circuit_permit = if let Some(circuit) = circuit {
            match circuit.try_acquire().await {
                Ok(circuit::CircuitDecision::Permit(permit)) => Some(permit),
                Ok(circuit::CircuitDecision::Open { retry_after_ms }) => {
                    if let Some(target) = target {
                        record_route_outcome(
                            &state,
                            route.map(|route| route.as_ref()),
                            target,
                            &model,
                            control_routes_authoritative,
                            false,
                        )
                        .await;
                    }
                    saw_open_circuit = true;
                    closest_circuit_retry_ms = Some(
                        closest_circuit_retry_ms
                            .map_or(retry_after_ms, |current| current.min(retry_after_ms)),
                    );
                    continue;
                }
                Err(_) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Provider health accounting unavailable",
                    )
                }
            }
        } else {
            None
        };
        let load_guard = target
            .map(|target| target.in_flight.clone())
            .or_else(|| {
                live_provider
                    .as_ref()
                    .map(|provider| provider.in_flight.clone())
            })
            .map(ProviderLoadGuard::new);
        let response = match tokio::time::timeout(HEADER_TIMEOUT, upstream.send()).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => {
                if let Some(target) = target {
                    record_route_outcome(
                        &state,
                        route.map(|route| route.as_ref()),
                        target,
                        &model,
                        control_routes_authoritative,
                        false,
                    )
                    .await;
                }
                if let (Some(circuit), Some(permit)) = (circuit, circuit_permit) {
                    if circuit.record_failure(permit).await.is_err() {
                        return error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "Provider health accounting unavailable",
                        );
                    }
                }
                if offset + 1 < attempts {
                    continue;
                }
                return error(StatusCode::BAD_GATEWAY, "Upstream unavailable");
            }
            Err(_) => {
                if let Some(target) = target {
                    record_route_outcome(
                        &state,
                        route.map(|route| route.as_ref()),
                        target,
                        &model,
                        control_routes_authoritative,
                        false,
                    )
                    .await;
                }
                if let (Some(circuit), Some(permit)) = (circuit, circuit_permit) {
                    if circuit.record_failure(permit).await.is_err() {
                        return error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "Provider health accounting unavailable",
                        );
                    }
                }
                if offset + 1 < attempts {
                    continue;
                }
                return error(StatusCode::GATEWAY_TIMEOUT, "Upstream response timed out");
            }
        };
        if let (Some(circuit), Some(permit)) = (circuit, circuit_permit) {
            let recorded = if circuit::provider_failure_status(response.status()) {
                circuit.record_failure(permit).await
            } else if response.status().is_success() {
                circuit.record_success(permit).await
            } else {
                circuit.record_ignored(permit).await;
                Ok(())
            };
            if recorded.is_err() {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Provider health accounting unavailable",
                );
            }
        }
        if let (Some(availability), Some(permit)) = (availability, availability_permit) {
            let rate_limit_scope = target
                .map(|target| target.rate_limit_scope)
                .or_else(|| {
                    live_provider
                        .as_ref()
                        .map(|provider| provider.rate_limit_scope)
                })
                .unwrap_or_default();
            let provider_name = target
                .and_then(|target| target.provider_name.as_deref())
                .or_else(|| {
                    live_provider
                        .as_ref()
                        .and_then(|provider| provider.provider_name.as_deref())
                });
            let quota_scope = resilience::quota_failure_scope(
                rate_limit_scope,
                provider_name,
                response.status(),
                response.headers(),
            );
            let recorded = if response.status() == StatusCode::UNAUTHORIZED
                && resilience::authentication_failure_is_terminal(provider_name)
            {
                availability
                    .record_terminal_failure(permit, availability::TerminalStatus::Expired)
                    .await
            } else if response.status() == StatusCode::PAYMENT_REQUIRED
                && quota_scope == resilience::FailureScope::Connection
            {
                availability
                    .record_terminal_failure(permit, availability::TerminalStatus::CreditsExhausted)
                    .await
            } else if matches!(
                response.status(),
                StatusCode::PAYMENT_REQUIRED | StatusCode::TOO_MANY_REQUESTS
            ) && quota_scope == resilience::FailureScope::Model
            {
                availability
                    .record_model_failure(
                        permit,
                        target_model,
                        response.status(),
                        retry_after_hint_ms(response.headers()),
                    )
                    .await
            } else if availability::connection_failure_status(response.status()) {
                availability
                    .record_connection_failure(
                        permit,
                        response.status(),
                        retry_after_hint_ms(response.headers()),
                    )
                    .await
            } else if availability::model_failure_status(response.status()) {
                availability
                    .record_model_failure(permit, target_model, response.status(), None)
                    .await
            } else if response.status().is_success() {
                availability.record_success(permit, target_model).await
            } else {
                Ok(())
            };
            if recorded.is_err() {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Provider availability accounting unavailable",
                );
            }
        }
        let retryable = response.status() == StatusCode::TOO_MANY_REQUESTS
            || response.status().is_server_error()
            || response.status() == StatusCode::REQUEST_TIMEOUT
            || (availability.is_some()
                && (availability::connection_failure_status(response.status())
                    || availability::model_failure_status(response.status())));
        if let Some(target) = target {
            if response.status().is_success() {
                record_route_outcome(
                    &state,
                    route.map(|route| route.as_ref()),
                    target,
                    &model,
                    control_routes_authoritative,
                    true,
                )
                .await;
            } else if retryable {
                record_route_outcome(
                    &state,
                    route.map(|route| route.as_ref()),
                    target,
                    &model,
                    control_routes_authoritative,
                    false,
                )
                .await;
            }
        }
        if retryable && offset + 1 < attempts {
            last_retry_response = Some(response);
            last_retry_load_guard = load_guard;
            continue;
        }
        final_translated = translate_anthropic;
        final_accounting = accounting_attempt;
        final_response = Some(response);
        final_load_guard = load_guard;
        break;
    }
    let (response, provider_load_guard) = if let Some(response) = final_response {
        (response, final_load_guard)
    } else if let Some(response) = last_retry_response {
        (response, last_retry_load_guard)
    } else {
        if saw_availability_block {
            return availability_blocked_error(
                closest_availability_retry_ms.unwrap_or(1_000),
                availability_model_scope,
                saw_terminal_availability,
            );
        }
        if saw_open_circuit {
            return circuit_open_error(closest_circuit_retry_ms.unwrap_or(1_000));
        }
        return error(StatusCode::BAD_GATEWAY, "Upstream unavailable");
    };
    // Redirects are intentionally not followed or relayed to the client.
    if response.status().is_redirection() {
        return error(StatusCode::BAD_GATEWAY, "Upstream redirect refused");
    }
    if final_translated && response.status().is_success() {
        if parsed.get("stream").and_then(serde_json::Value::as_bool) == Some(true) {
            let event_stream = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| {
                    value
                        .split(';')
                        .next()
                        .is_some_and(|media| media.trim().eq_ignore_ascii_case("text/event-stream"))
                });
            if !event_stream {
                return error(
                    StatusCode::BAD_GATEWAY,
                    "Invalid Anthropic stream content type",
                );
            }
            let include_usage = parsed
                .pointer("/stream_options/include_usage")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let stream = anthropic_stream::translate(response, include_usage).map(move |chunk| {
                let _keep_alive = (&permit, &client_permit, &provider_load_guard);
                chunk
            });
            return (
                [
                    (header::CONTENT_TYPE, "text/event-stream"),
                    (header::CACHE_CONTROL, "no-cache"),
                    (header::HeaderName::from_static("x-accel-buffering"), "no"),
                ],
                Body::from_stream(stream),
            )
                .into_response();
        }
        let read = async {
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| ())?;
                if bytes.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
                    return Err(());
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
            translation::response(&value).map_err(|_| ())
        };
        return match tokio::time::timeout(HEADER_TIMEOUT, read).await {
            Ok(Ok(value)) => (StatusCode::OK, Json(value)).into_response(),
            _ => error(StatusCode::BAD_GATEWAY, "Invalid Anthropic response"),
        };
    }
    if response.status().is_success() {
        if let Some((connection, model, prices, event_id)) = final_accounting {
            let Some(access) = &product_access else {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Usage accounting unavailable",
                );
            };
            let status = response.status();
            let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
            if accounting_stream {
                let event_stream = content_type
                    .as_ref()
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| {
                        v.split(';').next().is_some_and(|media| {
                            media.trim().eq_ignore_ascii_case("text/event-stream")
                        })
                    });
                if !event_stream {
                    return error(
                        StatusCode::BAD_GATEWAY,
                        "Invalid provider stream content type",
                    );
                }
                let body = usage_stream::forward(
                    response,
                    usage_stream::UsageContext {
                        connection,
                        event_id,
                        key: access.key_id.clone(),
                        model,
                        prices,
                        usage_attributes: access.usage_attributes.clone(),
                    },
                    (permit, client_permit),
                    provider_load_guard,
                );
                let mut result = Response::new(body);
                *result.status_mut() = status;
                result.headers_mut().insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("text/event-stream"),
                );
                result
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
                result
                    .headers_mut()
                    .insert("x-accel-buffering", HeaderValue::from_static("no"));
                return result;
            }
            let read = async {
                let mut bytes = Vec::new();
                let mut stream = response.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|_| ())?;
                    if bytes.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
                        return Err(());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok::<_, ()>(bytes)
            };
            let bytes = match tokio::time::timeout(HEADER_TIMEOUT, read).await {
                Ok(Ok(bytes)) => bytes,
                _ => return error(StatusCode::BAD_GATEWAY, "Invalid provider response"),
            };
            let usage = serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|v| {
                    if v.get("service_tier")
                        .is_some_and(|tier| !tier.is_null() && tier.as_str() != Some("default"))
                    {
                        return None;
                    }
                    match protocol {
                        ProviderProtocol::OpenAiEmbeddings => {
                            accounting::ChatUsage::from_embedding_response(&v).ok()
                        }
                        _ => accounting::ChatUsage::from_response(&v).ok(),
                    }
                });
            let Some(usage) = usage else {
                return error(
                    StatusCode::BAD_GATEWAY,
                    "Provider response is missing valid token usage",
                );
            };
            if connection
                .record_usage(
                    &event_id,
                    &access.key_id,
                    &model,
                    &usage,
                    prices.as_ref(),
                    &access.usage_attributes,
                )
                .await
                .is_err()
            {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Usage accounting unavailable",
                );
            }
            let mut result = Response::new(Body::from(bytes));
            *result.status_mut() = status;
            if let Some(content_type) = content_type {
                result
                    .headers_mut()
                    .insert(header::CONTENT_TYPE, content_type);
            }
            return result;
        }
    }
    let status = response.status();
    let mut headers = HeaderMap::new();
    for name in [
        header::CONTENT_TYPE,
        header::CACHE_CONTROL,
        header::RETRY_AFTER,
    ] {
        if let Some(value) = response.headers().get(&name) {
            headers.insert(name, value.clone());
        }
    }
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    // The permit is retained until the upstream stream finishes or the client drops it.
    let stream = response.bytes_stream().map(move |chunk| {
        let _keep_alive = (&permit, &client_permit, &provider_load_guard);
        chunk
    });
    let mut result = Response::new(Body::from_stream(stream));
    *result.status_mut() = status;
    *result.headers_mut() = headers;
    result
}

async fn record_route_outcome(
    state: &ProxyState,
    route: Option<&ModelRoute>,
    target: &ModelTarget,
    combo_id: &str,
    control_authoritative: bool,
    success: bool,
) {
    let Some(route) = route.filter(|route| route.strategy == RouteStrategy::Lkgp) else {
        return;
    };
    if control_authoritative {
        let Some(control) = &state.control_plane else {
            return;
        };
        let result = if success {
            control.record_route_success(combo_id, target).await
        } else {
            control.record_route_failure(combo_id, target).await
        };
        if result.is_err() {
            eprintln!("LKGP route pin persistence unavailable");
        }
    } else if success {
        route.set_last_good(target);
    } else {
        route.clear_last_good(target);
    }
}

#[cfg(test)]
mod address_tests {
    use super::*;

    #[test]
    fn metadata_and_private_addresses_are_not_public() {
        for ip in [
            "169.254.169.254",
            "100.100.100.200",
            "fd00:ec2::254",
            "::ffff:169.254.169.254",
        ] {
            assert!(!allowed_address(ip.parse().unwrap(), true));
        }
        assert!(!allowed_address("10.0.0.1".parse().unwrap(), false));
        assert!(allowed_address("10.0.0.1".parse().unwrap(), true));
        assert!(allowed_address("8.8.8.8".parse().unwrap(), false));
    }

    #[test]
    fn strict_random_deck_is_complete_and_never_repeats_at_cycle_boundaries() {
        for target_count in 2..=MAX_ROUTE_TARGETS {
            for seed in [route_seed("alpha"), route_seed("beta"), route_seed("gamma")] {
                let selections: Vec<_> = (0..target_count * 6)
                    .map(|ticket| {
                        let order = strict_random_order(target_count, seed, ticket);
                        let mut fallback = order[..target_count].to_vec();
                        fallback.sort_unstable();
                        assert_eq!(fallback, (0..target_count).collect::<Vec<_>>());
                        order[0]
                    })
                    .collect();
                for cycle in selections.chunks_exact(target_count) {
                    let mut complete = cycle.to_vec();
                    complete.sort_unstable();
                    assert_eq!(complete, (0..target_count).collect::<Vec<_>>());
                }
                assert!(selections.windows(2).all(|pair| pair[0] != pair[1]));
            }
        }
    }
}
