//! RedRouter's Rust proxy and production-backend migration target.
pub mod accounting;
mod anthropic_stream;
mod antigravity_translation;
pub mod audit_export;
mod availability;
pub mod catalog;
mod circuit;
pub mod control_plane;
pub mod fastllm_control;
pub mod fastllm_plan;
pub mod fastllm_supervisor;
mod kafka_export;
pub mod legacy_aliases;
pub mod legacy_archive;
pub mod legacy_cutover;
pub mod legacy_keys;
pub mod legacy_models;
pub mod legacy_preflight;
pub mod legacy_provider_nodes;
pub mod legacy_providers;
pub mod legacy_quota;
mod model_alias_response;
mod model_permissions;
mod native_usage;
mod oidc;
mod policy;
pub mod product;
pub mod product_combo;
pub mod product_provider;
mod provider_quota;
pub mod reconcile;
mod resilience;
pub mod shared_budget;
pub mod shared_usage;
pub mod spa;
pub mod storage;
mod translation;
mod usage_stream;
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Path, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use futures_util::{stream, stream::BoxStream, stream::FuturesUnordered, StreamExt};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    net::IpAddr,
    sync::{
        atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;

const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_PROVIDER_ERROR_BODY_BYTES: usize = 64 * 1024;
const MAX_IN_FLIGHT: usize = 64;
const MAX_ROUTE_TARGETS: usize = 8;
const NO_ROUTE_TARGET: usize = usize::MAX;
const HEADER_TIMEOUT: Duration = Duration::from_secs(120);
const ANTIGRAVITY_CREDITS_RETRY_TIMEOUT: Duration = Duration::from_secs(30);
const PROVIDER_ERROR_BODY_TIMEOUT: Duration = Duration::from_secs(2);
const RED_ROUTER_CATALOG_VERSION: &str = "x-redrouter-catalog-version";
const RED_ROUTER_SERVED_MODEL: &str = "x-redrouter-served-model";

fn public_endpoint_query(url: &reqwest::Url) -> bool {
    url.query_pairs().all(|(name, _)| {
        !matches!(
            name.to_ascii_lowercase().replace('-', "_").as_str(),
            "key"
                | "api_key"
                | "apikey"
                | "token"
                | "access_token"
                | "secret"
                | "signature"
                | "sig"
                | "credential"
                | "password"
                | "auth"
                | "authorization"
        )
    })
}
const ROUTING_STRATEGIES: &[&str] = &[
    "priority",
    "auto",
    "fill-first",
    "round-robin",
    "weighted",
    "random",
    "strict-random",
    "least-used",
    "p2c",
    "cost-optimized",
    "context-optimized",
    "cache-optimized",
    "context-relay",
    "fusion",
    "pipeline",
    "reset-aware",
    "reset-window",
    "headroom",
    "quota-weighted",
    "lkgp",
];

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum AntigravityCreditsMode {
    #[default]
    Off,
    Retry,
    Always,
}

struct BufferedProviderResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: Option<Bytes>,
}

enum ProviderResponse {
    Streaming(reqwest::Response),
    Buffered(BufferedProviderResponse),
}

impl ProviderResponse {
    fn status(&self) -> StatusCode {
        match self {
            Self::Streaming(response) => response.status(),
            Self::Buffered(response) => response.status,
        }
    }

    fn headers(&self) -> &HeaderMap {
        match self {
            Self::Streaming(response) => response.headers(),
            Self::Buffered(response) => &response.headers,
        }
    }

    fn error_body(&self) -> Option<&[u8]> {
        match self {
            Self::Streaming(_) => None,
            Self::Buffered(response) => response.body.as_deref(),
        }
    }

    fn into_streaming(self) -> Option<reqwest::Response> {
        match self {
            Self::Streaming(response) => Some(response),
            Self::Buffered(_) => None,
        }
    }

    fn into_body_stream(self) -> Option<BoxStream<'static, Result<Bytes, reqwest::Error>>> {
        match self {
            Self::Streaming(response) => Some(response.bytes_stream().boxed()),
            Self::Buffered(response) => response
                .body
                .map(|body| stream::once(async move { Ok(body) }).boxed()),
        }
    }
}

fn inspectable_provider_error(status: StatusCode) -> bool {
    matches!(status.as_u16(), 400 | 401 | 402 | 403 | 404 | 429)
}

async fn inspect_provider_response(response: reqwest::Response) -> ProviderResponse {
    if !inspectable_provider_error(response.status()) {
        return ProviderResponse::Streaming(response);
    }
    let status = response.status();
    let headers = response.headers().clone();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_ERROR_BODY_BYTES as u64)
    {
        return ProviderResponse::Buffered(BufferedProviderResponse {
            status,
            headers,
            body: None,
        });
    }
    let read = async move {
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ())?;
            if bytes.len().saturating_add(chunk.len()) > MAX_PROVIDER_ERROR_BODY_BYTES {
                return Err(());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok::<_, ()>(Bytes::from(bytes))
    };
    let body = match tokio::time::timeout(PROVIDER_ERROR_BODY_TIMEOUT, read).await {
        Ok(Ok(body)) => Some(body),
        _ => None,
    };
    ProviderResponse::Buffered(BufferedProviderResponse {
        status,
        headers,
        body,
    })
}

fn antigravity_credits_payload(payload: &[u8], enabled: bool) -> Result<Vec<u8>, ()> {
    let mut value = serde_json::from_slice::<serde_json::Value>(payload).map_err(|_| ())?;
    let object = value.as_object_mut().ok_or(())?;
    object.remove("enabledCreditTypes");
    if enabled {
        object.insert(
            "enabledCreditTypes".to_owned(),
            serde_json::json!(["GOOGLE_ONE_AI"]),
        );
    }
    serde_json::to_vec(&value).map_err(|_| ())
}

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
    native_usage_reporting: bool,
    antigravity_credits_mode: AntigravityCreditsMode,
}

#[derive(Clone)]
pub(crate) struct LiveProvider {
    client: reqwest::Client,
    upstream: reqwest::Url,
    provider_key: HeaderValue,
    custom_headers: HeaderMap,
    provider_id: Option<Arc<str>>,
    provider_name: Option<Arc<str>>,
    antigravity_project: Option<Arc<str>>,
    claude_identity: Option<Arc<ClaudeIdentity>>,
    tenant_id: Arc<str>,
    protocol: ProviderProtocol,
    auth_scheme: ProviderAuthScheme,
    credential_expires_at_unix: i64,
    rate_limit_scope: resilience::RateLimitScope,
    circuit: Option<Arc<circuit::ProviderCircuit>>,
    availability: Option<Arc<availability::ProviderAvailability>>,
    in_flight: Arc<AtomicUsize>,
}

#[derive(Clone)]
pub(crate) struct ClaudeIdentity {
    pub(crate) device_id: Arc<str>,
    pub(crate) account_uuid: Arc<str>,
    pub(crate) session_id: Arc<str>,
}

struct ProductFallback {
    connection: product::ProductConnection,
    provider_key: HeaderValue,
}

enum UsageAttempt {
    Product {
        connection: product::ProductConnection,
        model: String,
        prices: Option<accounting::TokenPrices>,
        event_id: String,
    },
    Native {
        control: control_plane::ControlPlane,
        identity: policy::ClientIdentity,
        attribution: native_usage::UsageAttribution,
        provider: String,
        model: String,
        prices: Option<accounting::TokenPrices>,
        event_id: String,
    },
    NativeRerank {
        control: control_plane::ControlPlane,
        identity: policy::ClientIdentity,
        attribution: native_usage::UsageAttribution,
        provider: String,
        model: String,
        price: Option<native_usage::RerankPrice>,
        event_id: String,
    },
}

impl UsageAttempt {
    fn into_context(
        self,
        access: Option<&product::ProductAccess>,
    ) -> Result<usage_stream::UsageContext, &'static str> {
        match self {
            Self::Product {
                connection,
                model,
                prices,
                event_id,
            } => {
                let access = access.ok_or("usage accounting unavailable")?;
                Ok(usage_stream::UsageContext::Product {
                    connection,
                    event_id,
                    key: access.key_id.clone(),
                    model,
                    prices,
                    usage_attributes: access.usage_attributes.clone(),
                })
            }
            Self::Native {
                control,
                identity,
                attribution,
                provider,
                model,
                prices,
                event_id,
            } => Ok(usage_stream::UsageContext::Native {
                control,
                identity,
                attribution,
                provider,
                model,
                prices,
                event_id,
            }),
            Self::NativeRerank { .. } => Err("rerank usage is not a token stream"),
        }
    }

    async fn record(
        self,
        access: Option<&product::ProductAccess>,
        usage: &accounting::ChatUsage,
    ) -> Result<(), &'static str> {
        self.into_context(access)?.record(usage).await
    }
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

    pub(crate) fn update_model(&self, quota: &storage::StoredProviderModelQuota) {
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
    public_model_alias: Option<Arc<str>>,
    tenant_id: Arc<str>,
    targets: Vec<ModelTarget>,
    protocol: ProviderProtocol,
    strategy: RouteStrategy,
    auto_weights: AutoRouteWeights,
    context_relay: control_plane::ComboContextRelayConfig,
    fusion: control_plane::ComboFusionConfig,
    pipeline: control_plane::ComboPipelineConfig,
    fallback: bool,
    cursor: AtomicUsize,
    seed: usize,
    last_good: AtomicUsize,
}

#[derive(Clone, Copy)]
pub(crate) struct AutoRouteWeights {
    pub(crate) quota: f64,
    pub(crate) cost: f64,
    pub(crate) context: f64,
    pub(crate) load: f64,
}

impl Default for AutoRouteWeights {
    fn default() -> Self {
        Self {
            quota: 0.30,
            cost: 0.25,
            context: 0.15,
            load: 0.30,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RouteStrategy {
    Priority,
    Auto,
    RoundRobin,
    Weighted,
    Random,
    LeastUsed,
    P2c,
    FillFirst,
    StrictRandom,
    CostOptimized,
    ContextOptimized,
    CacheOptimized,
    ContextRelay,
    Fusion,
    Pipeline,
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
    OpenAiToAntigravity,
    Gemini,
    Antigravity,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderAuthScheme {
    Auto,
    None,
    Bearer,
    XApiKey,
    XGoogApiKey,
}

pub(crate) struct ModelTarget {
    client: reqwest::Client,
    upstream: reqwest::Url,
    provider_key: HeaderValue,
    custom_headers: HeaderMap,
    model: String,
    protocol: ProviderProtocol,
    auth_scheme: ProviderAuthScheme,
    credential_expires_at_unix: i64,
    product_connection: Option<product::ProductConnection>,
    product_model: Option<String>,
    provider_id: Option<Arc<str>>,
    provider_name: Option<Arc<str>>,
    antigravity_project: Option<Arc<str>>,
    claude_identity: Option<Arc<ClaudeIdentity>>,
    rate_limit_scope: resilience::RateLimitScope,
    weight: u32,
    input_cost_per_million: Option<f64>,
    output_cost_per_million: Option<f64>,
    context_window_tokens: Option<u64>,
    prompt: Option<String>,
    quota: Option<Arc<TargetQuota>>,
    model_quota: Option<Arc<TargetQuota>>,
    circuit: Option<Arc<circuit::ProviderCircuit>>,
    availability: Option<Arc<availability::ProviderAvailability>>,
    in_flight: Arc<AtomicUsize>,
}

pub(crate) struct ControlTargetConfig {
    pub(crate) protocol: ProviderProtocol,
    pub(crate) model: String,
    pub(crate) weight: u32,
    pub(crate) input_cost_per_million: Option<f64>,
    pub(crate) output_cost_per_million: Option<f64>,
    pub(crate) context_window_tokens: Option<u64>,
    pub(crate) prompt: Option<String>,
}

#[derive(serde::Serialize)]
struct ModelListResponse {
    object: &'static str,
    data: Vec<ListedModel>,
}

#[derive(serde::Serialize)]
struct ListedModel {
    id: String,
    object: &'static str,
    created: u64,
    owned_by: &'static str,
    r#type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input_modalities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_modalities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<BTreeMap<&'static str, bool>>,
}

impl ModelRoute {
    fn target_allowed(
        &self,
        policy: &policy::ClientPolicy,
        public_model: &str,
        target: &ModelTarget,
    ) -> bool {
        let model = target.product_model.as_deref().unwrap_or(&target.model);
        let provider = if target.product_model.is_none() {
            target.provider_name.as_deref()
        } else {
            None
        };
        if self.public_model_alias.is_some() {
            policy.model_alias_target_allowed(public_model, model, provider)
        } else {
            policy.combo_provider_target_allowed(public_model, model, provider)
        }
    }
    fn selection_start(&self, eligible: &[&ModelTarget]) -> usize {
        match self.strategy {
            RouteStrategy::Priority
            | RouteStrategy::FillFirst
            | RouteStrategy::ContextRelay
            | RouteStrategy::Fusion
            | RouteStrategy::Pipeline => 0,
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
            RouteStrategy::Auto
            | RouteStrategy::StrictRandom
            | RouteStrategy::CostOptimized
            | RouteStrategy::ContextOptimized
            | RouteStrategy::CacheOptimized
            | RouteStrategy::ResetAware
            | RouteStrategy::ResetWindow
            | RouteStrategy::Headroom
            | RouteStrategy::QuotaWeighted
            | RouteStrategy::Lkgp => {
                unreachable!("strategy uses an ordered attempt deck")
            }
        }
    }

    fn attempt_order(
        &self,
        eligible: &[&ModelTarget],
        cache_affinity_key: Option<&str>,
    ) -> [usize; MAX_ROUTE_TARGETS] {
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
        if self.strategy == RouteStrategy::CacheOptimized {
            let Some(key) = cache_affinity_key else {
                let mut order = [0; MAX_ROUTE_TARGETS];
                for (index, slot) in order.iter_mut().take(eligible.len()).enumerate() {
                    *slot = index;
                }
                return order;
            };
            let mut order = [0; MAX_ROUTE_TARGETS];
            let mut scores = [[0_u8; 16]; MAX_ROUTE_TARGETS];
            for (index, target) in eligible.iter().enumerate() {
                order[index] = index;
                scores[index] = prompt_cache_rendezvous_score(key, target);
            }
            // Rendezvous hashing gives one stable account to the same reusable
            // prefix without storing per-conversation state. Ties retain the
            // dashboard order and fallbacks are ordered by the same affinity.
            for index in 1..eligible.len() {
                let selected = order[index];
                let mut position = index;
                while position > 0 && scores[selected] > scores[order[position - 1]] {
                    order[position] = order[position - 1];
                    position -= 1;
                }
                order[position] = selected;
            }
            return order;
        }
        if matches!(
            self.strategy,
            RouteStrategy::Auto
                | RouteStrategy::CostOptimized
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
            RouteStrategy::Auto => {
                auto_route_score(candidate, now_unix_ms, self.auto_weights)
                    > auto_route_score(current, now_unix_ms, self.auto_weights)
            }
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
            RouteStrategy::CacheOptimized => false,
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
    target
        .model_quota
        .as_ref()
        .and_then(|quota| quota.snapshot(now_unix_ms))
        .or_else(|| target.quota.as_ref()?.snapshot(now_unix_ms))
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

fn quota_preflight_allows(target: &ModelTarget, now_unix_ms: i64, threshold_ppm: i64) -> bool {
    let Some(quota) = target_quota(target, now_unix_ms) else {
        return true;
    };
    if quota.limit_reached {
        return false;
    }
    [quota.session_remaining_ppm, quota.weekly_remaining_ppm]
        .into_iter()
        .filter(|remaining| *remaining >= 0)
        .all(|remaining| remaining > threshold_ppm)
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

fn auto_route_score(target: &ModelTarget, now_unix_ms: i64, weights: AutoRouteWeights) -> f64 {
    let quota = quota_score(target, now_unix_ms);
    if !quota.is_finite() {
        return f64::NEG_INFINITY;
    }
    let cost = match (
        target.input_cost_per_million,
        target.output_cost_per_million,
    ) {
        (Some(input), Some(output)) => 1.0 / (1.0 + input + output),
        _ => 0.5,
    };
    let context = target.context_window_tokens.map_or(0.5, |tokens| {
        (tokens as f64).ln_1p() / 10_000_000_f64.ln_1p()
    });
    let load = 1.0 / (1.0 + target.in_flight.load(Ordering::Acquire) as f64);

    // Health and availability are hard gates before ordering. The remaining
    // score is deliberately small and allocation-free: quota/capacity, cost,
    // usable context and live load cover the signals the Rust snapshot owns.
    let total = weights.quota + weights.cost + weights.context + weights.load;
    (weights.quota * quota.clamp(0.0, 1.0)
        + weights.cost * cost.clamp(0.0, 1.0)
        + weights.context * context.clamp(0.0, 1.0)
        + weights.load * load)
        / total
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

fn prompt_cache_affinity_key(body: &serde_json::Value) -> Option<String> {
    let explicit = [
        body.get("prompt_cache_key"),
        body.pointer("/metadata/prompt_cache_key"),
    ]
    .into_iter()
    .flatten()
    .filter_map(serde_json::Value::as_str)
    .map(str::trim)
    .find(|value| !value.is_empty() && value.len() <= 4_096);
    if let Some(explicit) = explicit {
        return Some(explicit.to_owned());
    }

    let messages = body
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .or_else(|| body.get("input").and_then(serde_json::Value::as_array))?;
    let mut prefix = Vec::new();
    for message in messages {
        if message.is_string() {
            break;
        }
        let Some(object) = message.as_object() else {
            continue;
        };
        let Some(role) = object.get("role").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if !matches!(role, "system" | "tool" | "assistant") {
            break;
        }
        prefix.push(match object.get("content") {
            Some(serde_json::Value::String(value)) => value.clone(),
            Some(value) => serde_json::to_string(value).ok()?,
            None => "null".to_owned(),
        });
    }
    if prefix.is_empty() {
        return None;
    }
    let digest = Sha256::digest(prefix.join("\n").as_bytes());
    Some(format!("omni-{}", hex::encode(&digest[..16])))
}

fn prompt_cache_rendezvous_score(key: &str, target: &ModelTarget) -> [u8; 16] {
    let identity = target.provider_id.as_deref().map_or_else(
        || format!("route:{}\0{}", target.upstream, target.model),
        |provider_id| format!("connection:{provider_id}"),
    );
    let mut digest = Sha256::new();
    digest.update(key.as_bytes());
    digest.update([0]);
    digest.update(identity.as_bytes());
    digest.finalize()[..16]
        .try_into()
        .expect("SHA-256 rendezvous prefix has a fixed size")
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

#[derive(Clone, Copy)]
struct EndpointPolicy {
    custom_path: bool,
    allow_public_query: bool,
}

impl ProxyState {
    pub fn with_antigravity_credits_mode(mut self, mode: &str) -> Result<Self, &'static str> {
        self.antigravity_credits_mode = match mode.trim().to_ascii_lowercase().as_str() {
            "" | "off" => AntigravityCreditsMode::Off,
            "retry" => AntigravityCreditsMode::Retry,
            "always" => AntigravityCreditsMode::Always,
            _ => return Err("ANTIGRAVITY_CREDITS must be off, retry or always"),
        };
        Ok(self)
    }

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
            ProviderAuthScheme::Auto,
        )
        .await
    }

    async fn new_for_protocol(
        upstream: &str,
        client_key: &str,
        provider_key: &str,
        allow_private: bool,
        protocol: ProviderProtocol,
        auth_scheme: ProviderAuthScheme,
    ) -> Result<Self, &'static str> {
        Self::new_for_protocol_with_path(
            upstream,
            client_key,
            provider_key,
            allow_private,
            protocol,
            auth_scheme,
            EndpointPolicy {
                custom_path: false,
                allow_public_query: false,
            },
        )
        .await
    }

    async fn new_for_protocol_with_path(
        upstream: &str,
        client_key: &str,
        provider_key: &str,
        allow_private: bool,
        protocol: ProviderProtocol,
        auth_scheme: ProviderAuthScheme,
        endpoint_policy: EndpointPolicy,
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
            || (upstream.query().is_some()
                && (!endpoint_policy.allow_public_query || !public_endpoint_query(&upstream)))
            || upstream.fragment().is_some()
            || (!endpoint_policy.custom_path
                && !upstream.path().ends_with(match protocol {
                    ProviderProtocol::OpenAi => "/chat/completions",
                    ProviderProtocol::OpenAiResponses => "/responses",
                    ProviderProtocol::OpenAiEmbeddings => "/embeddings",
                    ProviderProtocol::CohereRerank => "/rerank",
                    ProviderProtocol::Anthropic | ProviderProtocol::OpenAiToAnthropic => {
                        "/messages"
                    }
                    ProviderProtocol::OpenAiToAntigravity | ProviderProtocol::Antigravity => {
                        "/v1internal:streamGenerateContent"
                    }
                    ProviderProtocol::Gemini => "/models",
                }))
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
        if !(16..=512).contains(&client_key.len())
            || (auth_scheme != ProviderAuthScheme::None
                && !(1..=8192).contains(&provider_key.len()))
            || (auth_scheme == ProviderAuthScheme::None && !provider_key.is_empty())
        {
            return Err("client key must be 16-512 bytes and provider credential 1-8192 bytes");
        }
        let auth_scheme = auth_scheme.resolve(protocol)?;
        let provider_credential = match auth_scheme {
            ProviderAuthScheme::None => String::new(),
            ProviderAuthScheme::Bearer => format!("Bearer {provider_key}"),
            ProviderAuthScheme::XApiKey | ProviderAuthScheme::XGoogApiKey => {
                provider_key.to_owned()
            }
            ProviderAuthScheme::Auto => unreachable!("authentication was resolved"),
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
            native_usage_reporting: false,
            antigravity_credits_mode: AntigravityCreditsMode::Off,
        })
    }

    /// Build the network-pinned runtime representation used by the Rust-owned
    /// control plane. Provider credentials never leave sensitive header storage.
    pub(crate) async fn live_provider(
        upstream: &str,
        provider_key: &str,
        allow_private: bool,
        auth_scheme: ProviderAuthScheme,
        credential_expires_at_unix: i64,
        configured_protocol: &str,
        allow_public_query: bool,
    ) -> Result<LiveProvider, &'static str> {
        let protocol = ProviderProtocol::from_configuration(upstream, configured_protocol)?;
        let state = Self::new_for_protocol_with_path(
            upstream,
            "rust-control-plane-validation-key",
            provider_key,
            allow_private,
            protocol,
            auth_scheme,
            EndpointPolicy {
                custom_path: configured_protocol != "auto",
                allow_public_query,
            },
        )
        .await?;
        Ok(LiveProvider {
            client: state.client,
            upstream: state.upstream,
            provider_key: state.provider_key,
            custom_headers: HeaderMap::new(),
            provider_id: None,
            provider_name: None,
            antigravity_project: None,
            claude_identity: None,
            tenant_id: Arc::from("red"),
            protocol,
            auth_scheme: auth_scheme.resolve(protocol)?,
            credential_expires_at_unix,
            rate_limit_scope: resilience::RateLimitScope::Auto,
            circuit: None,
            availability: None,
            in_flight: Arc::new(AtomicUsize::new(0)),
        })
    }

    pub(crate) fn control_target(
        provider: &LiveProvider,
        config: ControlTargetConfig,
        quota: Arc<TargetQuota>,
        model_quota: Arc<TargetQuota>,
    ) -> ModelTarget {
        ModelTarget {
            client: provider.client.clone(),
            upstream: provider.upstream.clone(),
            provider_key: provider.provider_key.clone(),
            custom_headers: provider.custom_headers.clone(),
            model: config.model,
            protocol: config.protocol,
            auth_scheme: provider.auth_scheme,
            credential_expires_at_unix: provider.credential_expires_at_unix,
            product_connection: None,
            product_model: None,
            provider_id: provider.provider_id.clone(),
            provider_name: provider.provider_name.clone(),
            antigravity_project: provider.antigravity_project.clone(),
            claude_identity: provider.claude_identity.clone(),
            rate_limit_scope: provider.rate_limit_scope,
            weight: config.weight,
            input_cost_per_million: config.input_cost_per_million,
            output_cost_per_million: config.output_cost_per_million,
            context_window_tokens: config.context_window_tokens,
            prompt: config.prompt,
            quota: Some(quota),
            model_quota: Some(model_quota),
            circuit: provider.circuit.clone(),
            availability: provider.availability.clone(),
            in_flight: provider.in_flight.clone(),
        }
    }

    pub fn with_control_plane(mut self, control_plane: control_plane::ControlPlane) -> Self {
        self.control_plane = Some(control_plane);
        self
    }

    pub fn with_native_usage_reporting(mut self, enabled: bool) -> Self {
        self.native_usage_reporting = enabled;
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
            target.provider_name = Some(Arc::from(source.provider.as_str()));
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
            if !connection.same_provider_database(primary) || !(1..=8192).contains(&key.len()) {
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
                Some(value) if value.as_str() == Some("openai-to-antigravity") => {
                    ProviderProtocol::OpenAiToAntigravity
                }
                Some(value) if value.as_str() == Some("gemini") => ProviderProtocol::Gemini,
                Some(value) if value.as_str() == Some("antigravity") => {
                    ProviderProtocol::Antigravity
                }
                _ => return Err("unsupported route protocol"),
            };
            if matches!(
                protocol,
                ProviderProtocol::Gemini
                    | ProviderProtocol::Antigravity
                    | ProviderProtocol::OpenAiToAntigravity
            ) && !valid_gemini_model(alias)
            {
                return Err("invalid Google route model");
            }
            let strategy = match object.get("strategy") {
                None => RouteStrategy::Priority,
                Some(v) if v.as_str() == Some("priority") => RouteStrategy::Priority,
                Some(v) if v.as_str() == Some("auto") => RouteStrategy::Auto,
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
                Some(v) if v.as_str() == Some("cache-optimized") => RouteStrategy::CacheOptimized,
                Some(v) if v.as_str() == Some("context-relay") => RouteStrategy::ContextRelay,
                Some(v) if v.as_str() == Some("fusion") => RouteStrategy::Fusion,
                Some(v) if v.as_str() == Some("pipeline") => RouteStrategy::Pipeline,
                Some(v) if v.as_str() == Some("reset-aware") => RouteStrategy::ResetAware,
                Some(v) if v.as_str() == Some("reset-window") => RouteStrategy::ResetWindow,
                Some(v) if v.as_str() == Some("headroom") => RouteStrategy::Headroom,
                Some(v) if v.as_str() == Some("quota-weighted") => RouteStrategy::QuotaWeighted,
                Some(v) if v.as_str() == Some("lkgp") => RouteStrategy::Lkgp,
                _ => return Err("unsupported route strategy"),
            };
            if matches!(
                strategy,
                RouteStrategy::ContextRelay | RouteStrategy::Fusion | RouteStrategy::Pipeline
            ) && matches!(
                protocol,
                ProviderProtocol::OpenAiEmbeddings | ProviderProtocol::CohereRerank
            ) {
                return Err("strategy requires a conversational protocol");
            }
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
                        "prompt",
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
                    Some(value)
                        if protocol == ProviderProtocol::OpenAi
                            && value.as_str() == Some("openai-to-antigravity") =>
                    {
                        ProviderProtocol::OpenAiToAntigravity
                    }
                    _ => return Err("unsupported target protocol for route"),
                };
                if matches!(
                    target_protocol,
                    ProviderProtocol::Gemini
                        | ProviderProtocol::Antigravity
                        | ProviderProtocol::OpenAiToAntigravity
                ) && !valid_gemini_model(model)
                {
                    return Err("invalid Google target model");
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
                let prompt = target
                    .get("prompt")
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::trim)
                            .filter(|value| {
                                !value.is_empty() && value.len() <= 20_000 && !value.contains('\0')
                            })
                            .map(str::to_owned)
                            .ok_or("invalid target prompt")
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
                let auth_scheme = match target.get("auth") {
                    None => ProviderAuthScheme::Auto.resolve(target_protocol)?,
                    Some(value)
                        if matches!(
                            target_protocol,
                            ProviderProtocol::Anthropic | ProviderProtocol::OpenAiToAnthropic
                        ) && value.as_str() == Some("x-api-key") =>
                    {
                        ProviderAuthScheme::XApiKey
                    }
                    Some(value)
                        if matches!(
                            target_protocol,
                            ProviderProtocol::Anthropic | ProviderProtocol::OpenAiToAnthropic
                        ) && value.as_str() == Some("bearer") =>
                    {
                        ProviderAuthScheme::Bearer
                    }
                    Some(value)
                        if target_protocol == ProviderProtocol::OpenAiToAntigravity
                            && value.as_str() == Some("bearer") =>
                    {
                        ProviderAuthScheme::Bearer
                    }
                    _ => return Err("unsupported target authentication"),
                };
                let proxy = Self::new_for_protocol(
                    url,
                    &self.client_key,
                    &secret,
                    allow_private,
                    target_protocol,
                    auth_scheme,
                )
                .await?;
                targets.push(ModelTarget {
                    client: proxy.client,
                    upstream: proxy.upstream,
                    provider_key: proxy.provider_key,
                    custom_headers: HeaderMap::new(),
                    model: model.to_string(),
                    protocol: target_protocol,
                    auth_scheme,
                    credential_expires_at_unix: 0,
                    product_connection: None,
                    product_model: None,
                    provider_id: None,
                    provider_name: None,
                    antigravity_project: None,
                    claude_identity: None,
                    rate_limit_scope: resilience::RateLimitScope::Auto,
                    weight,
                    input_cost_per_million,
                    output_cost_per_million,
                    context_window_tokens,
                    prompt,
                    quota: None,
                    model_quota: None,
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
                        public_model_alias: None,
                        tenant_id: Arc::from("red"),
                        targets,
                        protocol,
                        strategy,
                        auto_weights: AutoRouteWeights::default(),
                        context_relay: control_plane::ComboContextRelayConfig::default(),
                        fusion: control_plane::ComboFusionConfig::default(),
                        pipeline: control_plane::ComboPipelineConfig::default(),
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
    pub(crate) fn from_configuration(
        upstream: &str,
        configured: &str,
    ) -> Result<Self, &'static str> {
        if configured == "auto" {
            return Self::from_upstream(upstream);
        }
        let protocol = Self::parse(configured)?;
        match protocol {
            Self::OpenAi
            | Self::OpenAiResponses
            | Self::OpenAiEmbeddings
            | Self::CohereRerank
            | Self::Anthropic
            | Self::Gemini => Ok(protocol),
            _ => Err("explicit provider protocol must be a native API format"),
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "openai-responses" => Ok(Self::OpenAiResponses),
            "openai-embeddings" => Ok(Self::OpenAiEmbeddings),
            "cohere-rerank" => Ok(Self::CohereRerank),
            "anthropic" => Ok(Self::Anthropic),
            "openai-to-anthropic" => Ok(Self::OpenAiToAnthropic),
            "openai-to-antigravity" => Ok(Self::OpenAiToAntigravity),
            "gemini" => Ok(Self::Gemini),
            "antigravity" => Ok(Self::Antigravity),
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
        } else if path.ends_with("/v1internal:streamGenerateContent") {
            Ok(Self::Antigravity)
        } else {
            Err("unsupported provider endpoint protocol")
        }
    }

    pub(crate) fn accepts_provider(self, provider: Self) -> bool {
        self == provider
            || matches!(
                (self, provider),
                (Self::OpenAiToAnthropic, Self::Anthropic)
                    | (Self::OpenAiToAntigravity, Self::Antigravity)
            )
    }
}

impl ProviderAuthScheme {
    pub(crate) fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "auto" => Ok(Self::Auto),
            "none" => Ok(Self::None),
            "bearer" => Ok(Self::Bearer),
            "x-api-key" => Ok(Self::XApiKey),
            "x-goog-api-key" => Ok(Self::XGoogApiKey),
            _ => Err("unsupported provider authentication scheme"),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::None => "none",
            Self::Bearer => "bearer",
            Self::XApiKey => "x-api-key",
            Self::XGoogApiKey => "x-goog-api-key",
        }
    }

    fn resolve(self, protocol: ProviderProtocol) -> Result<Self, &'static str> {
        match (self, protocol) {
            (Self::None, ProviderProtocol::Antigravity | ProviderProtocol::OpenAiToAntigravity) => {
                Err("Antigravity endpoints require bearer authentication")
            }
            (Self::None, _) => Ok(Self::None),
            (Self::Auto, ProviderProtocol::Anthropic | ProviderProtocol::OpenAiToAnthropic) => {
                Ok(Self::XApiKey)
            }
            (Self::Auto, ProviderProtocol::Gemini) => Ok(Self::XGoogApiKey),
            (Self::Auto, _) => Ok(Self::Bearer),
            (Self::XGoogApiKey, ProviderProtocol::Gemini) => Ok(Self::XGoogApiKey),
            (
                Self::XGoogApiKey,
                ProviderProtocol::Antigravity | ProviderProtocol::OpenAiToAntigravity,
            ) => Err("Antigravity endpoints require bearer authentication"),
            (Self::XGoogApiKey, _) => Err("x-goog-api-key requires a Gemini endpoint"),
            (Self::Bearer, _) => Ok(Self::Bearer),
            (Self::XApiKey, ProviderProtocol::Gemini) => {
                Err("Gemini endpoints require bearer or x-goog-api-key authentication")
            }
            (
                Self::XApiKey,
                ProviderProtocol::Antigravity | ProviderProtocol::OpenAiToAntigravity,
            ) => Err("Antigravity endpoints require bearer authentication"),
            (Self::XApiKey, _) => Ok(Self::XApiKey),
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
        // Compatibility for the existing CLI/tray readiness probe. The Rust
        // server owns this route now; no Next.js handler is involved.
        .route(
            "/api/monitoring/health",
            get(|| async { Json(serde_json::json!({"status": "ok"})) }),
        )
        .route("/readyz", get(ready))
        .route("/api/auth/config", get(control_plane::auth_config))
        .route(
            "/api/auth/local/login",
            post(control_plane::local_admin_login),
        )
        .route("/api/auth/oidc/login", get(control_plane::oidc_login))
        .route("/api/auth/oidc/callback", get(control_plane::oidc_callback))
        .route("/api/auth/logout", post(control_plane::oidc_logout))
        .route(
            "/api/oauth/{provider}/authorize",
            get(control_plane::authorize_provider_oauth),
        )
        .route(
            "/api/oauth/{provider}/exchange",
            post(control_plane::exchange_provider_oauth),
        )
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
            "/api/admin/provider-nodes",
            get(control_plane::provider_nodes::list),
        )
        .route(
            "/api/admin/provider-nodes/{id}/headers",
            get(control_plane::provider_headers::get_node_headers)
                .put(control_plane::provider_headers::put_node_headers),
        )
        .route(
            "/api/admin/provider-nodes/{id}",
            get(control_plane::provider_nodes::get_node)
                .put(control_plane::provider_nodes::put)
                .delete(control_plane::provider_nodes::remove),
        )
        .route(
            "/api/admin/providers/{id}",
            put(control_plane::put_provider).delete(control_plane::delete_provider),
        )
        .route(
            "/api/admin/providers/{id}/purge",
            delete(control_plane::purge_provider),
        )
        .route(
            "/api/admin/providers/{id}/discovery",
            get(control_plane::provider_discovery::get_config)
                .put(control_plane::provider_discovery::put_config)
                .post(control_plane::provider_discovery::discover),
        )
        .route(
            "/api/admin/providers/{id}/headers",
            get(control_plane::provider_headers::get_headers)
                .put(control_plane::provider_headers::put_headers),
        )
        .route(
            "/api/admin/providers/{id}/test",
            post(control_plane::diagnose_provider),
        )
        .route(
            "/api/admin/providers/{id}/oauth/rotate",
            post(control_plane::rotate_provider_oauth),
        )
        .route(
            "/api/admin/providers/{id}/oauth/refresh",
            post(control_plane::refresh_provider_oauth),
        )
        .route(
            "/api/providers/{id}/refresh",
            post(control_plane::refresh_provider_oauth_compat),
        )
        .route(
            "/api/providers/codex-auth/import",
            post(control_plane::import_codex_auth),
        )
        .route(
            "/api/providers/codex-auth/import-bulk",
            post(control_plane::import_codex_auth_bulk),
        )
        .route(
            "/api/providers/codex-auth/zip-extract",
            post(control_plane::extract_codex_auth_zip),
        )
        .route(
            "/api/providers/{id}/codex-auth/export",
            post(control_plane::export_codex_auth),
        )
        .route(
            "/api/providers/claude-auth/import",
            post(control_plane::import_claude_auth),
        )
        .route(
            "/api/providers/claude-auth/import-bulk",
            post(control_plane::import_claude_auth_bulk),
        )
        .route(
            "/api/providers/claude-auth/zip-extract",
            post(control_plane::extract_claude_auth_zip),
        )
        .route(
            "/api/providers/{id}/claude-auth/export",
            post(control_plane::export_claude_auth),
        )
        .route(
            "/api/providers/agy-auth/import",
            post(control_plane::import_agy_auth),
        )
        .route(
            "/api/providers/agy-auth/import-bulk",
            post(control_plane::import_agy_auth_bulk),
        )
        .route(
            "/api/providers/agy-auth/zip-extract",
            post(control_plane::extract_agy_auth_zip),
        )
        .route(
            "/api/admin/client-keys",
            get(control_plane::list_client_keys).post(control_plane::issue_client_key),
        )
        .route(
            "/api/admin/client-keys/{id}",
            put(control_plane::put_client_key).delete(control_plane::delete_client_key),
        )
        .route(
            "/api/admin/budgets",
            get(control_plane::list_shared_budgets).post(control_plane::create_shared_budget),
        )
        .route(
            "/api/admin/budgets/{id}",
            put(control_plane::put_shared_budget).delete(control_plane::delete_shared_budget),
        )
        .route(
            "/api/usage/token-limits",
            get(control_plane::token_limits)
                .post(control_plane::put_token_limit)
                .delete(control_plane::delete_token_limit),
        )
        .route("/api/admin/usage", get(control_plane::get_usage_report))
        .route(
            "/api/admin/legacy-usage",
            get(control_plane::get_legacy_usage_report),
        )
        .route(
            "/api/admin/usage/maintenance",
            post(control_plane::maintain_usage),
        )
        .route(
            "/api/usage-sinks/types",
            get(control_plane::usage_export_types),
        )
        .route(
            "/api/usage-sinks",
            get(control_plane::list_usage_exports).post(control_plane::create_usage_export),
        )
        .route(
            "/api/usage-sinks/{id}",
            get(control_plane::get_usage_export)
                .patch(control_plane::update_usage_export)
                .put(control_plane::update_usage_export)
                .delete(control_plane::delete_usage_export),
        )
        .route(
            "/api/usage-sinks/{id}/test",
            post(control_plane::test_usage_export),
        )
        .route("/api/admin/tenants", get(control_plane::list_tenants))
        .route("/api/admin/tenants/{id}", put(control_plane::put_tenant))
        .route(
            "/api/admin/identity-bindings",
            get(control_plane::list_identity_bindings),
        )
        .route(
            "/api/admin/identity-bindings/{id}",
            put(control_plane::put_identity_binding).delete(control_plane::delete_identity_binding),
        )
        .route(
            "/api/admin/audit-log",
            get(control_plane::list_audit_events),
        )
        .route(
            "/api/compliance/audit-log",
            get(control_plane::list_audit_events),
        )
        .route(
            "/api/provision/client-keys/{id}",
            put(control_plane::provision_client_key),
        )
        .route("/api/admin/combos", get(control_plane::list_combos))
        .route(
            "/api/admin/model-aliases",
            get(control_plane::model_aliases::list).post(control_plane::model_aliases::create),
        )
        .route(
            "/api/admin/model-aliases/{id}",
            get(control_plane::model_aliases::get_one)
                .put(control_plane::model_aliases::put)
                .delete(control_plane::model_aliases::remove),
        )
        .route(
            "/api/admin/provider-models",
            get(control_plane::provider_models::list).post(control_plane::provider_models::create),
        )
        .route(
            "/api/admin/provider-models/{id}",
            put(control_plane::provider_models::put)
                .get(control_plane::provider_models::get_one)
                .delete(control_plane::provider_models::remove),
        )
        .route(
            "/api/admin/model-catalog",
            get(control_plane::list_model_catalog),
        )
        .route(
            "/api/admin/model-catalog/search/models",
            get(control_plane::search_model_catalog),
        )
        .route(
            "/api/admin/model-catalog/{provider}",
            get(control_plane::get_model_catalog_provider),
        )
        .route(
            "/api/admin/model-catalog/refresh",
            post(control_plane::refresh_model_catalog),
        )
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
            "/api/admin/runtime-settings",
            get(control_plane::get_runtime_settings).put(control_plane::put_runtime_settings),
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
        .route(
            "/api/admin/provider-quotas/{id}/refresh",
            post(control_plane::refresh_provider_quota),
        )
        .route("/api/v1/models", get(models))
        .route("/v1/models", get(models))
        .route("/api/v1/models/info", get(model_info))
        .route("/v1/models/info", get(model_info))
        .route("/api/v1/models/{*model}", get(model_by_id))
        .route("/v1/models/{*model}", get(model_by_id))
        .route("/api/v1/catalog", get(catalog_discovery))
        .route("/v1/catalog", get(catalog_discovery))
        .route("/api/v1/capabilities", get(capabilities_discovery))
        .route("/v1/capabilities", get(capabilities_discovery))
        .route("/api/v1/key", get(key_discovery))
        .route("/v1/key", get(key_discovery))
        .route("/v1/chat/completions", post(chat))
        .route("/v1/responses", post(responses))
        .route("/v1/embeddings", post(embeddings))
        .route("/v1/rerank", post(rerank))
        .route("/v1/messages", post(messages))
        .route("/v1/antigravity", post(antigravity))
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

fn model_list_response(data: Vec<ListedModel>) -> Response {
    let catalog_version = model_catalog_version(&data);
    let mut response = Json(ModelListResponse {
        object: "list",
        data,
    })
    .into_response();
    attach_model_catalog_headers(&mut response, catalog_version.as_deref());
    response
}

fn attach_model_catalog_headers(response: &mut Response, catalog_version: Option<&str>) {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("authorization"));
    if let Some(version) = catalog_version.and_then(|value| HeaderValue::from_str(value).ok()) {
        response
            .headers_mut()
            .insert(RED_ROUTER_CATALOG_VERSION, version);
    }
}

fn model_catalog_version(data: &[ListedModel]) -> Option<String> {
    let mut stable = serde_json::to_value(data).ok()?;
    for entry in stable.as_array_mut()? {
        entry.as_object_mut()?.remove("created");
    }
    let digest = Sha256::digest(serde_json::to_vec(&stable).ok()?);
    Some(hex::encode(digest)[..16].to_owned())
}

fn validate_discovery_query(uri: &Uri) -> bool {
    let mut seen_for = false;
    let mut seen_variants = false;
    for (name, value) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        match name.as_ref() {
            "for" if !seen_for && value.len() <= 128 => seen_for = true,
            "variants" if !seen_variants && value == "expand" => seen_variants = true,
            _ => return false,
        }
    }
    true
}

fn normalized_discovery_headers(headers: &HeaderMap) -> HeaderMap {
    if headers.contains_key(header::AUTHORIZATION) {
        return headers.clone();
    }
    let mut api_keys = headers.get_all("x-api-key").iter();
    let mut google_keys = headers.get_all("x-goog-api-key").iter();
    let api_key = api_keys.next();
    let google_key = google_keys.next();
    if api_keys.next().is_some()
        || google_keys.next().is_some()
        || [api_key.is_some(), google_key.is_some()]
            .into_iter()
            .filter(|value| *value)
            .count()
            != 1
    {
        return headers.clone();
    }
    let Some(candidate) = api_key.or(google_key).and_then(|value| value.to_str().ok()) else {
        return headers.clone();
    };
    let Ok(mut authorization) = HeaderValue::from_str(&format!("Bearer {candidate}")) else {
        return headers.clone();
    };
    authorization.set_sensitive(true);
    let mut normalized = headers.clone();
    normalized.remove("x-api-key");
    normalized.remove("x-goog-api-key");
    normalized.insert(header::AUTHORIZATION, authorization);
    normalized
}

fn private_discovery_response(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        header::VARY,
        HeaderValue::from_static("authorization, x-api-key, x-goog-api-key"),
    );
    if response.status() == StatusCode::UNAUTHORIZED {
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Bearer realm=\"red-router\""),
        );
    }
    response
}

fn discovery_response(body: serde_json::Value, version: &str) -> Response {
    let mut response = private_discovery_response(Json(body).into_response());
    if let Ok(value) = HeaderValue::from_str(version) {
        response
            .headers_mut()
            .insert(RED_ROUTER_CATALOG_VERSION, value);
    }
    response
}

async fn key_discovery(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let headers = normalized_discovery_headers(&headers);
    let identity = if state.product_client_keys {
        match authenticate_product_request(&state, &headers, ProviderProtocol::OpenAi).await {
            Ok((access, _, _)) => Some((
                access.key_id,
                access.key_name,
                "standard",
                access.key_id_format,
            )),
            Err(response) => return private_discovery_response(*response),
        }
    } else {
        let Some(control) = &state.control_plane else {
            return private_discovery_response(error(StatusCode::UNAUTHORIZED, "Invalid API key"));
        };
        let policies = match control.client_policies().await {
            Ok(Some(policies)) => policies,
            Ok(None) => {
                return private_discovery_response(error(
                    StatusCode::UNAUTHORIZED,
                    "Invalid API key",
                ))
            }
            Err(_) => {
                return private_discovery_response(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Client key identity unavailable",
                ))
            }
        };
        policies
            .authenticate(&headers, ProviderProtocol::OpenAi)
            .and_then(|policy| policy.identity())
            .map(|identity| {
                (
                    identity.id.to_string(),
                    identity.name.to_string(),
                    identity.role,
                    identity.id_format.to_string(),
                )
            })
    };
    let Some((id, name, role, id_format)) = identity else {
        return private_discovery_response(error(StatusCode::UNAUTHORIZED, "Invalid API key"));
    };
    private_discovery_response(
        Json(serde_json::json!({
            "object":"api_key",
            "id":id,
            "name":name,
            "role":role,
            "id_format":id_format,
            "persisted":true,
            "compatibility":{"baseline":"v0.33.0","complete":false}
        }))
        .into_response(),
    )
}

fn served_model_header(provider: Option<&str>, model: &str) -> Option<HeaderValue> {
    let provider = provider?.trim();
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let identity = if model
        .strip_prefix(provider)
        .is_some_and(|suffix| suffix.starts_with('/'))
    {
        model.to_owned()
    } else {
        format!("{provider}/{model}")
    };
    HeaderValue::from_str(&identity).ok()
}

fn attach_served_model(response: &mut Response, served_model: Option<&HeaderValue>) {
    if let Some(value) = served_model {
        response
            .headers_mut()
            .insert(RED_ROUTER_SERVED_MODEL, value.clone());
    }
}

fn route_category(protocol: ProviderProtocol) -> &'static str {
    match protocol {
        ProviderProtocol::OpenAiEmbeddings => "embeddings",
        ProviderProtocol::CohereRerank => "rerank",
        _ => "chat",
    }
}

fn route_model_type(protocol: ProviderProtocol) -> &'static str {
    match protocol {
        ProviderProtocol::OpenAiEmbeddings => "embedding",
        ProviderProtocol::CohereRerank => "rerank",
        _ => "chat",
    }
}

fn intersect_modalities(values: &[Vec<String>]) -> Option<Vec<String>> {
    let (first, rest) = values.split_first()?;
    let intersection = first
        .iter()
        .filter(|candidate| rest.iter().all(|value| value.contains(candidate)))
        .cloned()
        .collect::<Vec<_>>();
    (!intersection.is_empty()).then_some(intersection)
}

fn common_capability(
    metadata: &[catalog::ModelMetadata],
    read: impl Fn(&catalog::ModelMetadata) -> Option<bool>,
) -> Option<bool> {
    let first = read(metadata.first()?)?;
    metadata
        .iter()
        .skip(1)
        .all(|entry| read(entry) == Some(first))
        .then_some(first)
}

fn listed_models(
    routes: &HashMap<String, Arc<ModelRoute>>,
    policy: &policy::ClientPolicy,
    catalog: &catalog::ModelCatalog,
    overrides: Option<&control_plane::provider_models::ModelOverrides>,
) -> Result<Vec<ListedModel>, &'static str> {
    let created = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before the Unix epoch")?
        .as_secs();
    let mut route_ids = routes.keys().collect::<Vec<_>>();
    route_ids.sort_unstable();
    let mut models = Vec::with_capacity(route_ids.len());

    for id in route_ids {
        let route = &routes[id];
        let id = route.public_model_alias.as_deref().unwrap_or(id);
        if !policy.tenant_allowed(&route.tenant_id)
            || (route.public_model_alias.is_none() && !policy.combo_allowed(id))
            || !policy.endpoint_allowed(route_category(route.protocol))
        {
            continue;
        }
        let eligible = route
            .targets
            .iter()
            .filter(|target| {
                route.target_allowed(policy, id, target)
                    && policy.provider_allowed(target.provider_id.as_deref())
            })
            .collect::<Vec<_>>();
        if eligible.is_empty() {
            continue;
        }

        let mut metadata = Vec::new();
        let mut context_lengths = Vec::new();
        let mut max_input_tokens = Vec::new();
        let mut max_output_tokens = Vec::new();
        let mut input_modalities = Vec::new();
        let mut output_modalities = Vec::new();
        for target in eligible {
            let discovered = match target.provider_name.as_deref() {
                Some(provider) => match overrides {
                    Some(overrides) => {
                        overrides.model(catalog, &route.tenant_id, provider, &target.model)?
                    }
                    None => catalog.model(provider, &target.model)?,
                },
                None => None,
            };
            let catalog_context = discovered
                .as_ref()
                .and_then(|entry| entry.limit.as_ref())
                .and_then(|limit| limit.context);
            let context = target.context_window_tokens.or(catalog_context);
            if let Some(value) = context {
                context_lengths.push(value);
            }
            if let Some(value) = discovered
                .as_ref()
                .and_then(|entry| entry.limit.as_ref())
                .and_then(|limit| limit.input)
                .or(context)
            {
                max_input_tokens.push(value);
            }
            if let Some(value) = discovered
                .as_ref()
                .and_then(|entry| entry.limit.as_ref())
                .and_then(|limit| limit.output)
            {
                max_output_tokens.push(value);
            }
            if let Some(entry) = discovered {
                input_modalities.push(
                    entry
                        .modalities
                        .as_ref()
                        .map(|modalities| modalities.input.clone())
                        .unwrap_or_default(),
                );
                output_modalities.push(
                    entry
                        .modalities
                        .as_ref()
                        .map(|modalities| modalities.output.clone())
                        .unwrap_or_default(),
                );
                metadata.push(entry);
            }
        }

        let mut capabilities = BTreeMap::new();
        for (name, value) in [
            (
                "tool_calling",
                common_capability(&metadata, |entry| entry.tool_call),
            ),
            (
                "reasoning",
                common_capability(&metadata, |entry| entry.reasoning),
            ),
            (
                "attachment",
                common_capability(&metadata, |entry| entry.attachment),
            ),
            (
                "structured_output",
                common_capability(&metadata, |entry| entry.structured_output),
            ),
            (
                "temperature",
                common_capability(&metadata, |entry| entry.temperature),
            ),
            (
                "vision",
                common_capability(&metadata, |entry| {
                    entry
                        .modalities
                        .as_ref()
                        .map(|modalities| modalities.input.iter().any(|value| value == "image"))
                }),
            ),
        ] {
            if let Some(value) = value {
                capabilities.insert(name, value);
            }
        }
        models.push(ListedModel {
            id: id.to_owned(),
            object: "model",
            created,
            owned_by: if route.public_model_alias.is_some() {
                "provider"
            } else {
                "combo"
            },
            r#type: route_model_type(route.protocol),
            context_length: context_lengths.into_iter().min(),
            max_input_tokens: max_input_tokens.into_iter().min(),
            max_output_tokens: max_output_tokens.into_iter().min(),
            input_modalities: intersect_modalities(&input_modalities),
            output_modalities: intersect_modalities(&output_modalities),
            capabilities: (!capabilities.is_empty()).then_some(capabilities),
        });
    }
    Ok(models)
}

async fn authenticate_product_request(
    state: &ProxyState,
    headers: &HeaderMap,
    protocol: ProviderProtocol,
) -> Result<(product::ProductAccess, usize, zeroize::Zeroizing<String>), Box<Response>> {
    let Some(candidate) = policy::extract_candidate(headers, protocol) else {
        return Err(Box::new(error(StatusCode::UNAUTHORIZED, "Invalid API key")));
    };
    let candidate = zeroize::Zeroizing::new(candidate.to_owned());
    let Some(primary) = &state.product_connection else {
        return Err(Box::new(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Product policy unavailable",
        )));
    };
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
            .client_policies(
                &candidate,
                state.product_combo.as_ref().map(|combo| combo.name()),
            )
            .await
        {
            Ok(Some(access)) => return Ok((access, index, candidate)),
            Ok(None) => continue,
            Err(_) => {
                return Err(Box::new(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Product policy unavailable or unsupported",
                )))
            }
        }
    }
    Err(Box::new(error(StatusCode::UNAUTHORIZED, "Invalid API key")))
}

async fn authorized_models(
    state: &ProxyState,
    headers: &HeaderMap,
) -> Result<Vec<ListedModel>, Box<Response>> {
    let catalog = match &state.control_plane {
        Some(control) => control.model_catalog().await,
        None => catalog::bundled_catalog().map_err(|_| {
            Box::new(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Model catalog unavailable",
            ))
        })?,
    };
    if state.product_client_keys {
        let (access, _, _) =
            authenticate_product_request(state, headers, ProviderProtocol::OpenAi).await?;
        let Some(policy) = access
            .policies
            .authenticate(headers, ProviderProtocol::OpenAi)
        else {
            return Err(Box::new(error(StatusCode::UNAUTHORIZED, "Invalid API key")));
        };
        if let Some(combo) = &state.product_combo {
            if !combo.unchanged().await {
                return Err(Box::new(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Product combo changed or is unavailable; restart required",
                )));
            }
            return listed_models(state.routes.as_ref(), policy, &catalog, None).map_err(|_| {
                Box::new(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Model catalog unavailable",
                ))
            });
        }
        // Direct provider mode has no durable, entitlement-scoped inventory.
        // Never turn the descriptive models.dev catalog into an allow-list.
        return Ok(Vec::new());
    }

    let control_clients = match &state.control_plane {
        Some(control) => match control.client_policies().await {
            Ok(policies) => policies,
            Err(_) => {
                return Err(Box::new(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Client key policy unavailable",
                )))
            }
        },
        None => None,
    };
    let clients = control_clients.as_deref().unwrap_or(state.clients.as_ref());
    let Some(policy) = clients.authenticate(headers, ProviderProtocol::OpenAi) else {
        return Err(Box::new(error(StatusCode::UNAUTHORIZED, "Invalid API key")));
    };
    let control_routes = match &state.control_plane {
        Some(control) => match control.routes().await {
            Ok(routes) => routes,
            Err(_) => {
                return Err(Box::new(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Combo routing policy unavailable",
                )))
            }
        },
        None => None,
    };
    let routes = control_routes.as_deref().unwrap_or(state.routes.as_ref());
    let overrides = match &state.control_plane {
        Some(control) => Some(control.provider_model_overrides().await.map_err(|_| {
            Box::new(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Provider model metadata unavailable",
            ))
        })?),
        None => None,
    };
    listed_models(routes, policy, &catalog, overrides.as_deref()).map_err(|_| {
        Box::new(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Model catalog unavailable",
        ))
    })
}

async fn models(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    match authorized_models(&state, &headers).await {
        Ok(models) => model_list_response(models),
        Err(response) => *response,
    }
}

fn valid_model_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1_024
        && !value.bytes().any(|byte| byte < b' ' || byte == 0x7f)
}

fn model_not_found(requested: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": {
                "message": format!("The model '{requested}' does not exist"),
                "type": "invalid_request_error",
                "code": "model_not_found"
            }
        })),
    )
        .into_response()
}

fn find_listed_model<'a>(models: &'a [ListedModel], requested: &str) -> Option<&'a ListedModel> {
    models
        .iter()
        .find(|model| model.id == requested)
        .or_else(|| {
            models
                .iter()
                .find(|model| model.id.eq_ignore_ascii_case(requested))
        })
}

async fn model_by_id(
    State(state): State<ProxyState>,
    Path(requested): Path<String>,
    headers: HeaderMap,
) -> Response {
    let models = match authorized_models(&state, &headers).await {
        Ok(models) => models,
        Err(response) => return *response,
    };
    let requested = requested.strip_prefix('/').unwrap_or(&requested);
    if !valid_model_identifier(requested) {
        let mut response = error(StatusCode::BAD_REQUEST, "Invalid model identifier");
        let catalog_version = model_catalog_version(&models);
        attach_model_catalog_headers(&mut response, catalog_version.as_deref());
        return response;
    }
    let catalog_version = model_catalog_version(&models);
    if matches!(requested, "systemone" | "decisions") {
        let mut response = Json(serde_json::json!({
            "object":"list",
            "id_format":"prefixed",
            "data":models.iter().filter(|model| model.r#type == "systemone").collect::<Vec<_>>()
        }))
        .into_response();
        attach_model_catalog_headers(&mut response, catalog_version.as_deref());
        return response;
    }
    let mut response = match find_listed_model(&models, requested) {
        Some(model) => Json(model).into_response(),
        None => model_not_found(requested),
    };
    attach_model_catalog_headers(&mut response, catalog_version.as_deref());
    response
}

fn parse_model_info_query(uri: &Uri) -> Option<(String, Option<String>)> {
    let mut id = None;
    let mut kind = None;
    for (name, value) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        match name.as_ref() {
            "id" if id.is_none() && valid_model_identifier(&value) => id = Some(value.into_owned()),
            "kind"
                if kind.is_none()
                    && matches!(
                        value.as_ref(),
                        "llm"
                            | "image"
                            | "imageToText"
                            | "tts"
                            | "stt"
                            | "embedding"
                            | "rerank"
                            | "moderation"
                            | "video"
                            | "music"
                            | "systemone"
                            | "webSearch"
                            | "webFetch"
                    ) =>
            {
                kind = Some(value.into_owned())
            }
            _ => return None,
        }
    }
    id.map(|id| (id, kind))
}

fn model_info_kind(model: &ListedModel) -> &'static str {
    match model.r#type {
        "chat" => "llm",
        value => value,
    }
}

fn model_endpoint(kind: &str) -> Option<&'static str> {
    match kind {
        "llm" | "imageToText" => Some("/v1/chat/completions"),
        "image" => Some("/v1/images/generations"),
        "tts" => Some("/v1/audio/speech"),
        "stt" => Some("/v1/audio/transcriptions"),
        "embedding" => Some("/v1/embeddings"),
        "rerank" => Some("/v1/rerank"),
        "moderation" => Some("/v1/moderations"),
        "video" => Some("/v1/videos/generations"),
        "music" => Some("/v1/music/generations"),
        "systemone" => Some("/v1/systemone"),
        "webSearch" => Some("/v1/search"),
        "webFetch" => Some("/v1/web/fetch"),
        _ => None,
    }
}

fn listed_model_info(model: &ListedModel) -> serde_json::Value {
    let kind = model_info_kind(model);
    let mut info = serde_json::json!({
        "id":model.id,
        "name":model.id,
        "kind":kind,
        "owned_by":model.owned_by,
        "endpoint":model_endpoint(kind)
    });
    let object = info
        .as_object_mut()
        .expect("model info is constructed as an object");
    if let Some(value) = model.context_length {
        object.insert("contextWindow".to_owned(), value.into());
    }
    if let Some(value) = model.max_input_tokens {
        object.insert("max_input_tokens".to_owned(), value.into());
    }
    if let Some(value) = model.max_output_tokens {
        object.insert("max_output_tokens".to_owned(), value.into());
    }
    for (name, value) in [
        ("input_modalities", model.input_modalities.as_ref()),
        ("output_modalities", model.output_modalities.as_ref()),
    ] {
        if let Some(value) = value {
            object.insert(name.to_owned(), serde_json::json!(value));
        }
    }
    if let Some(value) = &model.capabilities {
        object.insert("capabilities".to_owned(), serde_json::json!(value));
    }
    info
}

async fn model_info(State(state): State<ProxyState>, uri: Uri, headers: HeaderMap) -> Response {
    let models = match authorized_models(&state, &headers).await {
        Ok(models) => models,
        Err(response) => return *response,
    };
    let catalog_version = model_catalog_version(&models);
    let Some((requested, requested_kind)) = parse_model_info_query(&uri) else {
        let mut response = error(StatusCode::BAD_REQUEST, "Invalid model info query");
        attach_model_catalog_headers(&mut response, catalog_version.as_deref());
        return response;
    };
    let selected = find_listed_model(&models, &requested).filter(|model| {
        requested_kind
            .as_deref()
            .is_none_or(|kind| kind == model_info_kind(model))
    });
    let mut response = match selected {
        Some(model) => Json(listed_model_info(model)).into_response(),
        None => model_not_found(&requested),
    };
    attach_model_catalog_headers(&mut response, catalog_version.as_deref());
    response
}

async fn catalog_discovery(
    State(state): State<ProxyState>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let headers = normalized_discovery_headers(&headers);
    let models = match authorized_models(&state, &headers).await {
        Ok(models) => models,
        Err(response) => return private_discovery_response(*response),
    };
    if !validate_discovery_query(&uri) {
        return private_discovery_response(error(
            StatusCode::BAD_REQUEST,
            "Unsupported discovery query; only for and variants=expand are supported",
        ));
    }
    let Some(version) = model_catalog_version(&models) else {
        return private_discovery_response(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Model catalog unavailable",
        ));
    };
    discovery_response(
        serde_json::json!({
            "version":version,
            "groups":[],
            "combos":models,
            "aliases":[],
            "recommended":{},
            "compatibility":{"baseline":"v0.33.0","complete":false}
        }),
        &version,
    )
}

async fn capabilities_discovery(
    State(state): State<ProxyState>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let headers = normalized_discovery_headers(&headers);
    let models = match authorized_models(&state, &headers).await {
        Ok(models) => models,
        Err(response) => return private_discovery_response(*response),
    };
    if !validate_discovery_query(&uri) {
        return private_discovery_response(error(
            StatusCode::BAD_REQUEST,
            "Unsupported discovery query; only for and variants=expand are supported",
        ));
    }
    let Some(version) = model_catalog_version(&models) else {
        return private_discovery_response(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Model catalog unavailable",
        ));
    };
    discovery_response(
        serde_json::json!({
            "product":"red-router",
            "version":env!("CARGO_PKG_VERSION"),
            "systemone":{
                "endpoint":"/v1/systemone",
                "aliases":["/v1/decisions"],
                "models":[],
                "available":false,
                "availability":"not_implemented"
            },
            "combos":{"strategies":ROUTING_STRATEGIES},
            "served_model_header":"X-RedRouter-Served-Model",
            "catalog":{
                "version":version,
                "catalog_endpoint":"/v1/catalog",
                "variants":"expand",
                "recommendations":false,
                "account_metadata":false,
                "key_id_format_applied":false
            },
            "compatibility":{"baseline":"v0.33.0","complete":false}
        }),
        &version,
    )
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

async fn antigravity(State(state): State<ProxyState>, request: Request) -> Response {
    proxy_request(state, request, ProviderProtocol::Antigravity, None).await
}

fn parse_context_relay_session_id(headers: &HeaderMap) -> Result<Option<String>, ()> {
    let values = ["x-omniroute-session-id", "x-session-id"]
        .into_iter()
        .flat_map(|name| headers.get_all(name).iter())
        .map(|value| value.to_str().map(str::trim).map_err(|_| ()))
        .collect::<Result<Vec<_>, _>>()?;
    if values.is_empty() {
        return Ok(None);
    }
    if values.iter().any(|value| {
        value.is_empty() || value.len() > 256 || !value.as_bytes().iter().all(u8::is_ascii_graphic)
    }) || values.iter().any(|value| *value != values[0])
    {
        return Err(());
    }
    Ok(Some(values[0].to_owned()))
}

fn context_relay_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

const CONTEXT_RELAY_SUMMARY_TTL_MS: i64 = 5 * 60 * 60 * 1_000;
const CONTEXT_RELAY_SUMMARY_MAX_RESPONSE_BYTES: usize = 256 * 1024;
const CONTEXT_RELAY_SUMMARY_MAX_HISTORY_CHARS: usize = 32_000;
const CONTEXT_RELAY_EXHAUSTION_THRESHOLD: f64 = 0.95;
const CONTEXT_RELAY_SUMMARY_DEADLINE: Duration = Duration::from_secs(45);
const ANTIGRAVITY_CLI_USER_AGENT: &str =
    "antigravity/cli/1.1.5 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)";
const CLAUDE_CLI_USER_AGENT: &str = "claude-cli/2.1.301 (external, cli)";
const CLAUDE_SENTINEL: &str = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";
const GITHUB_COPILOT_CLI_VERSION: &str = "1.0.88";

fn github_copilot_cli_version() -> String {
    std::env::var("GITHUB_COPILOT_CLI_VERSION")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 32
                && value.bytes().enumerate().all(|(index, byte)| {
                    byte.is_ascii_alphanumeric()
                        || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
                })
        })
        .unwrap_or_else(|| GITHUB_COPILOT_CLI_VERSION.to_owned())
}

fn github_copilot_machine_id(provider_id: Option<&str>) -> String {
    let mut bytes: [u8; 16] = Sha256::digest(provider_id.unwrap_or("github-copilot").as_bytes())
        [..16]
        .try_into()
        .expect("SHA-256 prefix is always 16 bytes");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

pub(crate) fn github_copilot_headers(
    request: reqwest::RequestBuilder,
    provider_name: Option<&str>,
    provider_id: Option<&str>,
) -> reqwest::RequestBuilder {
    if provider_name != Some("github") {
        return request;
    }
    let version = github_copilot_cli_version();
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        value => value,
    };
    request
        .header("copilot-integration-id", "copilot-developer-cli")
        .header("editor-version", format!("copilot/{version}"))
        .header(
            header::USER_AGENT,
            format!("copilot/{version} ({platform}) term/unknown"),
        )
        .header("openai-intent", "conversation-agent")
        .header("x-interaction-type", "conversation-user")
        .header("copilot-harness-id", "copilot-sdk")
        .header("x-github-api-version", "2026-08-01")
        .header(
            "x-client-machine-id",
            github_copilot_machine_id(provider_id),
        )
        .header("x-initiator", "user")
}

pub(crate) fn github_copilot_refresh_headers(
    request: reqwest::RequestBuilder,
) -> reqwest::RequestBuilder {
    let version = github_copilot_cli_version();
    request
        .header(header::ACCEPT, "application/json")
        .header(header::USER_AGENT, "GithubCopilot/1.0")
        .header("editor-version", format!("copilot/{version}"))
        .header("editor-plugin-version", format!("copilot/{version}"))
}

fn claude_cli_payload(payload: &[u8], identity: &ClaudeIdentity) -> Result<Vec<u8>, ()> {
    let mut value: serde_json::Value = serde_json::from_slice(payload).map_err(|_| ())?;
    let object = value.as_object_mut().ok_or(())?;
    let mut system = match object.remove("system") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::String(text)) => {
            vec![serde_json::json!({"type":"text","text":text})]
        }
        Some(serde_json::Value::Array(values)) => values,
        Some(_) => return Err(()),
    };
    system.retain(|block| {
        block
            .get("text")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|text| {
                !text.starts_with("x-anthropic-billing-header:")
                    && !text.starts_with(CLAUDE_SENTINEL)
            })
    });
    system.insert(
        0,
        serde_json::json!({"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.301; cc_entrypoint=cli; cch=00000;"}),
    );
    system.insert(1, serde_json::json!({"type":"text","text":CLAUDE_SENTINEL}));
    object.insert("system".to_owned(), serde_json::Value::Array(system));
    let metadata = object
        .entry("metadata".to_owned())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or(())?;
    metadata.insert(
        "user_id".to_owned(),
        serde_json::Value::String(
            serde_json::json!({
                "device_id": identity.device_id.as_ref(),
                "account_uuid": identity.account_uuid.as_ref(),
                "session_id": identity.session_id.as_ref(),
            })
            .to_string(),
        ),
    );
    serde_json::to_vec(&value).map_err(|_| ())
}

fn request_uuid_v4() -> Result<String, ()> {
    let mut value = [0_u8; 16];
    getrandom::fill(&mut value).map_err(|_| ())?;
    value[6] = (value[6] & 0x0f) | 0x40;
    value[8] = (value[8] & 0x3f) | 0x80;
    let value = hex::encode(value);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &value[0..8],
        &value[8..12],
        &value[12..16],
        &value[16..20],
        &value[20..32]
    ))
}

#[derive(Clone)]
struct ContextRelaySummaryTarget {
    client: reqwest::Client,
    upstream: reqwest::Url,
    provider_key: HeaderValue,
    custom_headers: HeaderMap,
    protocol: ProviderProtocol,
    auth_scheme: ProviderAuthScheme,
    tenant_id: Arc<str>,
    provider_name: String,
    model: String,
    antigravity_project: Option<Arc<str>>,
    claude_identity: Option<Arc<ClaudeIdentity>>,
    rate_limit_scope: resilience::RateLimitScope,
    circuit: Option<Arc<circuit::ProviderCircuit>>,
    availability: Option<Arc<availability::ProviderAvailability>>,
    in_flight: Arc<AtomicUsize>,
}

struct ContextRelayGeneratedSummary {
    handoff: control_plane::ContextRelayHandoff,
    summary_model: String,
    usage: accounting::ChatUsage,
}

enum ContextRelaySummaryOutcome {
    Generated(ContextRelayGeneratedSummary),
    Rejected {
        status: StatusCode,
        headers: HeaderMap,
        error_body: Option<Bytes>,
    },
    InvalidSuccess,
    TransportFailure,
}

fn context_relay_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Array(values) => values
            .iter()
            .map(context_relay_text)
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        serde_json::Value::Object(value) => ["text", "content", "parts"]
            .into_iter()
            .filter_map(|key| value.get(key))
            .map(context_relay_text)
            .find(|value| !value.trim().is_empty())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn context_relay_history(
    body: &serde_json::Value,
    maximum_messages: usize,
    schema_locked: bool,
) -> Option<(String, usize)> {
    let object = body.as_object()?;
    let messages = object
        .get("messages")
        .or_else(|| object.get("input"))
        .or_else(|| object.get("contents"));
    let mut entries = match messages {
        Some(serde_json::Value::Array(messages)) => messages
            .iter()
            .filter_map(|message| {
                let role = message
                    .get("role")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown");
                let content = message
                    .get("content")
                    .or_else(|| message.get("parts"))
                    .map(context_relay_text)
                    .unwrap_or_default();
                (!content.trim().is_empty()).then(|| (role.to_owned(), content))
            })
            .collect::<Vec<_>>(),
        Some(serde_json::Value::String(input)) if !input.trim().is_empty() => {
            vec![("user".to_owned(), input.clone())]
        }
        _ => Vec::new(),
    };
    let message_count = entries.len();
    if !schema_locked {
        if let Some(instructions) = object
            .get("instructions")
            .or_else(|| object.get("system"))
            .or_else(|| object.get("systemInstruction"))
        {
            let content = context_relay_text(instructions);
            if !content.trim().is_empty() {
                entries.insert(0, ("system".to_owned(), content));
            }
        }
    }
    let (systems, mut conversation): (Vec<_>, Vec<_>) = entries
        .into_iter()
        .partition(|(role, _)| matches!(role.as_str(), "system" | "developer"));
    if schema_locked {
        conversation = conversation
            .into_iter()
            .rev()
            .take(maximum_messages)
            .collect::<Vec<_>>();
        conversation.reverse();
    } else {
        let mut recent = conversation
            .into_iter()
            .rev()
            .take(maximum_messages)
            .collect::<Vec<_>>();
        recent.reverse();
        conversation = systems.into_iter().chain(recent).collect();
    }
    let mut history = conversation
        .into_iter()
        .enumerate()
        .map(|(index, (role, content))| {
            format!(
                "[{}] {}:\n{}",
                index + 1,
                role.to_ascii_uppercase(),
                content
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    if history.chars().count() > CONTEXT_RELAY_SUMMARY_MAX_HISTORY_CHARS {
        history = history
            .chars()
            .rev()
            .take(CONTEXT_RELAY_SUMMARY_MAX_HISTORY_CHARS)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
    }
    (!history.trim().is_empty()).then_some((history, message_count))
}

fn context_relay_summary_target(
    route: &ModelRoute,
    eligible: &[&ModelTarget],
    successful: &ModelTarget,
) -> Option<ContextRelaySummaryTarget> {
    if route.context_relay.handoff_providers.is_empty() {
        return None;
    }
    let target = if route.context_relay.handoff_model.is_empty() {
        successful
    } else {
        eligible.iter().copied().find(|target| {
            target.model == route.context_relay.handoff_model
                || target.provider_name.as_deref().is_some_and(|provider| {
                    format!("{provider}/{}", target.model) == route.context_relay.handoff_model
                })
        })?
    };
    let provider = target.provider_name.as_deref()?.to_ascii_lowercase();
    if !route
        .context_relay
        .handoff_providers
        .iter()
        .any(|allowed| allowed == &provider)
        || !matches!(
            target.protocol,
            ProviderProtocol::OpenAi
                | ProviderProtocol::OpenAiResponses
                | ProviderProtocol::Anthropic
                | ProviderProtocol::OpenAiToAnthropic
                | ProviderProtocol::Gemini
                | ProviderProtocol::Antigravity
                | ProviderProtocol::OpenAiToAntigravity
        )
    {
        return None;
    }
    Some(ContextRelaySummaryTarget {
        client: target.client.clone(),
        upstream: target.upstream.clone(),
        provider_key: target.provider_key.clone(),
        custom_headers: target.custom_headers.clone(),
        protocol: target.protocol,
        auth_scheme: target.auth_scheme.resolve(target.protocol).ok()?,
        tenant_id: route.tenant_id.clone(),
        provider_name: provider,
        model: target.model.clone(),
        antigravity_project: target.antigravity_project.clone(),
        claude_identity: target.claude_identity.clone(),
        rate_limit_scope: target.rate_limit_scope,
        circuit: target.circuit.clone(),
        availability: target.availability.clone(),
        in_flight: target.in_flight.clone(),
    })
}

fn context_relay_target_changed(previous: &(String, String), target: &ModelTarget) -> bool {
    target.provider_id.as_deref() != Some(previous.0.as_str()) || target.model != previous.1
}

fn context_relay_quota_expiry(
    target: &ModelTarget,
    warning_threshold: f64,
    now_unix_ms: i64,
) -> Option<i64> {
    let quota = target_quota(target, now_unix_ms)?;
    if quota.limit_reached {
        return None;
    }
    let used = 1.0 - remaining_fraction(quota.session_remaining_ppm)?;
    if used < warning_threshold || used >= CONTEXT_RELAY_EXHAUSTION_THRESHOLD {
        return None;
    }
    Some(if quota.session_reset_unix_ms > now_unix_ms {
        quota.session_reset_unix_ms
    } else {
        now_unix_ms.saturating_add(CONTEXT_RELAY_SUMMARY_TTL_MS)
    })
}

fn context_relay_response_text(value: &serde_json::Value) -> String {
    if let Some(content) = value
        .pointer("/choices/0/message/content")
        .map(context_relay_text)
        .filter(|content| !content.trim().is_empty())
    {
        return content;
    }
    for pointer in ["/output", "/content", "/candidates/0/content/parts"] {
        if let Some(content) = value
            .pointer(pointer)
            .map(context_relay_text)
            .filter(|content| !content.trim().is_empty())
        {
            return content;
        }
    }
    String::new()
}

fn context_relay_bounded_string(value: &serde_json::Value, maximum: usize) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(maximum)
        .collect()
}

fn context_relay_string_list(
    value: Option<&serde_json::Value>,
    maximum_items: usize,
) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .take(maximum_items)
        .map(|value| value.chars().take(240).collect())
        .collect()
}

fn parse_context_relay_summary(
    response: &serde_json::Value,
    source_model: &str,
    message_count: usize,
) -> Option<control_plane::ContextRelayHandoff> {
    let mut content = context_relay_response_text(response).trim().to_owned();
    if content.starts_with("```") {
        content = content
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
            .to_owned();
    }
    if serde_json::from_str::<serde_json::Value>(&content).is_err() {
        let start = content.find('{')?;
        let end = content.rfind('}')?;
        content = content.get(start..=end)?.to_owned();
    }
    let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
    let summary = context_relay_bounded_string(parsed.get("summary")?, 2_000);
    if summary.is_empty() {
        return None;
    }
    Some(control_plane::ContextRelayHandoff {
        summary,
        key_decisions: context_relay_string_list(parsed.get("keyDecisions"), 8),
        task_progress: parsed
            .get("taskProgress")
            .map_or_else(String::new, |value| {
                context_relay_bounded_string(value, 1_200)
            }),
        active_entities: context_relay_string_list(parsed.get("activeEntities"), 10),
        message_count,
        source_model: source_model.to_owned(),
    })
}

async fn generate_context_relay_summary(
    target: &ContextRelaySummaryTarget,
    history: String,
    source_model: String,
    message_count: usize,
) -> ContextRelaySummaryOutcome {
    let prompt = format!(
        "You are a context summarizer. Analyze the conversation below and return ONLY a JSON object with this exact structure: {{\"summary\":\"dense continuation summary, maximum 200 words\",\"keyDecisions\":[\"decision\"],\"taskProgress\":\"done, pending, and next steps\",\"activeEntities\":[\"file, feature, or topic\"]}}. Do not invent facts.\n\nCONVERSATION HISTORY:\n{history}"
    );
    let chat_body = serde_json::json!({
        "model":target.model.clone(),
        "messages":[{"role":"user","content":prompt.clone()}],
        "stream":false,
        "max_tokens":800
    });
    let mut body = match target.protocol {
        ProviderProtocol::OpenAi => {
            let mut body = serde_json::json!({
                "model":target.model.clone(),
                "messages":[{"role":"user","content":prompt}],
                "stream":false
            });
            let token_limit = if target.provider_name == "openai" {
                "max_completion_tokens"
            } else {
                "max_tokens"
            };
            body[token_limit] = serde_json::json!(800);
            body
        }
        ProviderProtocol::OpenAiResponses => serde_json::json!({
            "model":target.model.clone(),
            "input":prompt,
            "stream":false,
            "max_output_tokens":800
        }),
        ProviderProtocol::Anthropic | ProviderProtocol::OpenAiToAnthropic => serde_json::json!({
            "model":target.model.clone(),
            "messages":[{"role":"user","content":prompt}],
            "stream":false,
            "max_tokens":800
        }),
        ProviderProtocol::Gemini => serde_json::json!({
            "contents":[{"role":"user","parts":[{"text":prompt}]}],
            "generationConfig":{
                "maxOutputTokens":800,
                "responseMimeType":"application/json"
            }
        }),
        ProviderProtocol::Antigravity | ProviderProtocol::OpenAiToAntigravity => {
            let Ok(body) = antigravity_translation::request(
                &chat_body,
                &target.model,
                target.antigravity_project.as_deref(),
                None,
            ) else {
                return ContextRelaySummaryOutcome::InvalidSuccess;
            };
            body
        }
        _ => return ContextRelaySummaryOutcome::InvalidSuccess,
    };
    let claude_request_id = if let Some(identity) = target.claude_identity.as_deref() {
        let Ok(encoded) = serde_json::to_vec(&body) else {
            return ContextRelaySummaryOutcome::InvalidSuccess;
        };
        let Ok(encoded) = claude_cli_payload(&encoded, identity) else {
            return ContextRelaySummaryOutcome::InvalidSuccess;
        };
        let Ok(cloaked) = serde_json::from_slice(&encoded) else {
            return ContextRelaySummaryOutcome::InvalidSuccess;
        };
        body = cloaked;
        match request_uuid_v4() {
            Ok(value) => Some(value),
            Err(()) => return ContextRelaySummaryOutcome::InvalidSuccess,
        }
    } else {
        None
    };
    let antigravity = matches!(
        target.protocol,
        ProviderProtocol::Antigravity | ProviderProtocol::OpenAiToAntigravity
    );
    let mut upstream = target.upstream.clone();
    if target.protocol == ProviderProtocol::Gemini {
        upstream.set_path(&format!(
            "{}/{}:generateContent",
            upstream.path(),
            target.model
        ));
    } else if antigravity {
        upstream.set_query(Some("alt=sse"));
    }
    let build_request = |include_antigravity_project: bool| {
        let mut request = target
            .client
            .post(upstream.clone())
            .header(header::CONTENT_TYPE, "application/json")
            .json(&body);
        request = match target.auth_scheme {
            ProviderAuthScheme::Bearer => {
                request.header(header::AUTHORIZATION, target.provider_key.clone())
            }
            ProviderAuthScheme::XApiKey => request.header("x-api-key", target.provider_key.clone()),
            ProviderAuthScheme::XGoogApiKey => {
                request.header("x-goog-api-key", target.provider_key.clone())
            }
            ProviderAuthScheme::None => request,
            ProviderAuthScheme::Auto => return None,
        };
        request = github_copilot_headers(
            request,
            Some(target.provider_name.as_str()),
            Some(target.provider_name.as_str()),
        );
        if matches!(
            target.protocol,
            ProviderProtocol::Anthropic | ProviderProtocol::OpenAiToAnthropic
        ) {
            request = request.header("anthropic-version", "2023-06-01");
        }
        if let Some(identity) = target.claude_identity.as_deref() {
            request = request
                .header("anthropic-beta", CLAUDE_OAUTH_BETA)
                .header("anthropic-dangerous-direct-browser-access", "true")
                .header("x-app", "cli")
                .header(header::USER_AGENT, CLAUDE_CLI_USER_AGENT)
                .header("x-stainless-timeout", "600")
                .header("x-claude-code-session-id", identity.session_id.as_ref());
            if let Some(request_id) = claude_request_id.as_deref() {
                request = request.header("x-client-request-id", request_id);
            }
        }
        if antigravity {
            request = request
                .header(header::ACCEPT, "text/event-stream")
                .header(header::USER_AGENT, ANTIGRAVITY_CLI_USER_AGENT);
            if include_antigravity_project {
                if let Some(project) = target.antigravity_project.as_deref() {
                    request = request.header("x-goog-user-project", project);
                }
            }
        }
        Some(request.headers(target.custom_headers.clone()))
    };
    let Some(request) = build_request(true) else {
        return ContextRelaySummaryOutcome::InvalidSuccess;
    };
    let response = match tokio::time::timeout(Duration::from_secs(30), request.send()).await {
        Ok(Ok(response)) => response,
        _ => return ContextRelaySummaryOutcome::TransportFailure,
    };
    let response = if antigravity
        && response.status() == StatusCode::FORBIDDEN
        && target.antigravity_project.is_some()
    {
        let Some(request) = build_request(false) else {
            return ContextRelaySummaryOutcome::InvalidSuccess;
        };
        match tokio::time::timeout(Duration::from_secs(30), request.send()).await {
            Ok(Ok(response)) => response,
            _ => return ContextRelaySummaryOutcome::TransportFailure,
        }
    } else {
        response
    };
    if !response.status().is_success() {
        let response = inspect_provider_response(response).await;
        return ContextRelaySummaryOutcome::Rejected {
            status: response.status(),
            headers: response.headers().clone(),
            error_body: response.error_body().map(Bytes::copy_from_slice),
        };
    }
    if antigravity
        && !response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"))
    {
        return ContextRelaySummaryOutcome::InvalidSuccess;
    }
    if response
        .content_length()
        .is_some_and(|length| length > CONTEXT_RELAY_SUMMARY_MAX_RESPONSE_BYTES as u64)
    {
        return ContextRelaySummaryOutcome::InvalidSuccess;
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return ContextRelaySummaryOutcome::TransportFailure;
        };
        if bytes.len().saturating_add(chunk.len()) > CONTEXT_RELAY_SUMMARY_MAX_RESPONSE_BYTES {
            return ContextRelaySummaryOutcome::InvalidSuccess;
        }
        bytes.extend_from_slice(&chunk);
    }
    let response: serde_json::Value = if antigravity {
        let Ok(response) = antigravity_translation::response(&bytes, &target.model) else {
            return ContextRelaySummaryOutcome::InvalidSuccess;
        };
        response.value
    } else {
        let Ok(response) = serde_json::from_slice(&bytes) else {
            return ContextRelaySummaryOutcome::InvalidSuccess;
        };
        response
    };
    let usage = match target.protocol {
        ProviderProtocol::OpenAi
        | ProviderProtocol::Antigravity
        | ProviderProtocol::OpenAiToAntigravity => accounting::ChatUsage::from_response(&response),
        ProviderProtocol::OpenAiResponses => {
            accounting::ChatUsage::from_responses_response(&response)
        }
        ProviderProtocol::Anthropic | ProviderProtocol::OpenAiToAnthropic => {
            accounting::ChatUsage::from_anthropic_response(&response)
        }
        ProviderProtocol::Gemini => accounting::ChatUsage::from_gemini_response(&response),
        _ => return ContextRelaySummaryOutcome::InvalidSuccess,
    };
    let (Ok(usage), Some(handoff)) = (
        usage,
        parse_context_relay_summary(&response, &source_model, message_count),
    ) else {
        return ContextRelaySummaryOutcome::InvalidSuccess;
    };
    ContextRelaySummaryOutcome::Generated(ContextRelayGeneratedSummary {
        handoff,
        summary_model: target.model.clone(),
        usage,
    })
}

async fn record_internal_provider_health(
    target: &ContextRelaySummaryTarget,
    circuit_permit: Option<circuit::CircuitPermit>,
    availability_permit: Option<availability::AvailabilityPermit>,
    status: Option<StatusCode>,
    headers: Option<&HeaderMap>,
    error_body: Option<&[u8]>,
) -> Result<(), &'static str> {
    if let (Some(circuit), Some(permit)) = (target.circuit.as_ref(), circuit_permit) {
        match status {
            None => circuit.record_failure(permit).await?,
            Some(status) if circuit::provider_failure_status(status) => {
                circuit.record_failure(permit).await?
            }
            Some(status) if status.is_success() => circuit.record_success(permit).await?,
            Some(_) => {
                circuit.record_ignored(permit).await;
            }
        }
    }
    let (Some(availability), Some(permit), Some(status)) =
        (target.availability.as_ref(), availability_permit, status)
    else {
        return Ok(());
    };
    let empty_headers = HeaderMap::new();
    let headers = headers.unwrap_or(&empty_headers);
    let failure_class = resilience::classify_provider_failure(
        target.rate_limit_scope,
        Some(&target.provider_name),
        status,
        headers,
        error_body,
    );
    match failure_class {
        resilience::ProviderFailureClass::Banned => {
            availability
                .record_terminal_failure(permit, availability::TerminalStatus::Banned)
                .await
        }
        resilience::ProviderFailureClass::Expired => {
            availability
                .record_terminal_failure(permit, availability::TerminalStatus::Expired)
                .await
        }
        resilience::ProviderFailureClass::AmbiguousExpired => {
            availability
                .record_ambiguous_auth_failure(permit, status, retry_after_hint_ms(headers))
                .await
        }
        resilience::ProviderFailureClass::CreditsExhausted => {
            availability
                .record_terminal_failure(permit, availability::TerminalStatus::CreditsExhausted)
                .await
        }
        resilience::ProviderFailureClass::Model => {
            availability
                .record_model_failure(permit, &target.model, status, retry_after_hint_ms(headers))
                .await
        }
        resilience::ProviderFailureClass::Transient
            if availability::connection_failure_status(status) =>
        {
            availability
                .record_connection_failure(permit, status, retry_after_hint_ms(headers))
                .await
        }
        resilience::ProviderFailureClass::Transient
            if availability::model_failure_status(status) =>
        {
            availability
                .record_model_failure(permit, &target.model, status, retry_after_hint_ms(headers))
                .await
        }
        resilience::ProviderFailureClass::Transient if status.is_success() => {
            availability.record_success(permit, &target.model).await
        }
        resilience::ProviderFailureClass::Transient => Ok(()),
    }
}

#[derive(Debug)]
struct FusionPanelAnswer {
    target_index: usize,
    text: String,
}

struct FusionPreparation {
    judge_body: Option<serde_json::Value>,
    attempt_order: [usize; MAX_ROUTE_TARGETS],
}

struct FusionFailure {
    status: StatusCode,
    message: &'static str,
}

struct PipelinePreparation {
    body: serde_json::Value,
    attempt_order: [usize; MAX_ROUTE_TARGETS],
}

struct PipelineFailure {
    status: StatusCode,
    message: &'static str,
}

#[derive(Clone, Copy, Debug)]
struct InternalTargetFailure {
    status: Option<StatusCode>,
}

impl InternalTargetFailure {
    const fn internal() -> Self {
        Self { status: None }
    }

    const fn upstream(status: StatusCode) -> Self {
        Self {
            status: Some(status),
        }
    }

    fn retryable(self) -> bool {
        matches!(
            self.status,
            Some(
                StatusCode::TOO_MANY_REQUESTS
                    | StatusCode::BAD_GATEWAY
                    | StatusCode::SERVICE_UNAVAILABLE
                    | StatusCode::GATEWAY_TIMEOUT
            )
        )
    }
}

fn internal_target_from_model(
    route: &ModelRoute,
    target: &ModelTarget,
) -> Option<ContextRelaySummaryTarget> {
    Some(ContextRelaySummaryTarget {
        client: target.client.clone(),
        upstream: target.upstream.clone(),
        provider_key: target.provider_key.clone(),
        custom_headers: target.custom_headers.clone(),
        protocol: target.protocol,
        auth_scheme: target.auth_scheme.resolve(target.protocol).ok()?,
        tenant_id: route.tenant_id.clone(),
        provider_name: target
            .provider_name
            .as_deref()
            .unwrap_or("openai-compatible")
            .to_ascii_lowercase(),
        model: target.model.clone(),
        antigravity_project: target.antigravity_project.clone(),
        claude_identity: target.claude_identity.clone(),
        rate_limit_scope: target.rate_limit_scope,
        circuit: target.circuit.clone(),
        availability: target.availability.clone(),
        in_flight: target.in_flight.clone(),
    })
}

fn fusion_request_has_tools(body: &serde_json::Value) -> bool {
    body.get("tools")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|tools| !tools.is_empty())
        && body.get("tool_choice").and_then(serde_json::Value::as_str) != Some("none")
}

fn fusion_judge_prompt(answers: &[FusionPanelAnswer]) -> String {
    let panel = answers
        .iter()
        .enumerate()
        .map(|(index, answer)| format!("[Source {}]\n{}", index + 1, answer.text))
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        "You are the JUDGE in a model-fusion panel. {} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.\n\nDo not mention the panel or sources. Produce one authoritative final answer addressed directly to the user. Internally analyze consensus, contradictions, partial coverage, unique insights and shared blind spots. Use your own reasoning: override an incorrect consensus, preserve a correct minority insight, and add important facts the panel missed. Be honest about uncertainty and avoid filler.\n\n=== PANEL RESPONSES ===\n{}\n=== END PANEL RESPONSES ===\n\nNow write the best final answer to the user's original request.",
        answers.len(),
        panel
    )
}

fn fusion_append_judge_prompt(
    body: &serde_json::Value,
    prompt: String,
) -> Option<serde_json::Value> {
    let mut next = body.clone();
    let object = next.as_object_mut()?;
    if let Some(messages) = object
        .get_mut("messages")
        .and_then(serde_json::Value::as_array_mut)
    {
        messages.push(serde_json::json!({"role":"user","content":prompt}));
    } else if let Some(input) = object.get_mut("input") {
        match input {
            serde_json::Value::Array(input) => {
                input.push(serde_json::json!({"role":"user","content":prompt}));
            }
            serde_json::Value::String(previous) => {
                *input = serde_json::json!([
                    {"role":"user","content":previous.clone()},
                    {"role":"user","content":prompt}
                ]);
            }
            _ => return None,
        }
    } else if let Some(contents) = object
        .get_mut("contents")
        .and_then(serde_json::Value::as_array_mut)
    {
        contents.push(serde_json::json!({
            "role":"user",
            "parts":[{"text":prompt}]
        }));
    } else {
        object.insert(
            "messages".to_owned(),
            serde_json::json!([{"role":"user","content":prompt}]),
        );
    }
    Some(next)
}

fn fusion_attempt_order(
    eligible: &[&ModelTarget],
    judge_index: usize,
    answers: &[FusionPanelAnswer],
) -> [usize; MAX_ROUTE_TARGETS] {
    let mut order = [0; MAX_ROUTE_TARGETS];
    order[0] = judge_index;
    let mut output = 1;
    for answer in answers {
        if answer.target_index != judge_index && !order[..output].contains(&answer.target_index) {
            order[output] = answer.target_index;
            output += 1;
        }
    }
    for index in 0..eligible.len() {
        if index != judge_index && !order[..output].contains(&index) {
            order[output] = index;
            output += 1;
        }
    }
    order
}

fn pipeline_attempt_order(final_index: usize, target_count: usize) -> [usize; MAX_ROUTE_TARGETS] {
    let mut order = [0; MAX_ROUTE_TARGETS];
    order[0] = final_index;
    let mut output = 1;
    for index in 0..target_count {
        if index != final_index {
            order[output] = index;
            output += 1;
        }
    }
    order
}

fn pipeline_prepend_system_instruction(
    body: &serde_json::Value,
    prompt: Option<&str>,
    protocol: ProviderProtocol,
) -> Option<serde_json::Value> {
    let Some(prompt) = prompt.filter(|prompt| !prompt.is_empty()) else {
        return Some(body.clone());
    };
    let mut next = body.clone();
    let object = next.as_object_mut()?;
    if protocol == ProviderProtocol::Anthropic {
        let system = object
            .get("system")
            .and_then(serde_json::Value::as_str)
            .map_or_else(
                || prompt.to_owned(),
                |system| format!("{prompt}\n\n{system}"),
            );
        object.insert("system".to_owned(), serde_json::Value::String(system));
    } else if let Some(input) = object.get_mut("input") {
        match input {
            serde_json::Value::Array(input) => {
                input.insert(0, serde_json::json!({"role":"system","content":prompt}));
            }
            serde_json::Value::String(previous) => {
                *input = serde_json::json!([
                    {"role":"system","content":prompt},
                    {"role":"user","content":previous.clone()}
                ]);
            }
            _ => return None,
        }
    } else if let Some(contents) = object
        .get_mut("contents")
        .and_then(serde_json::Value::as_array_mut)
    {
        contents.insert(
            0,
            serde_json::json!({"role":"user","parts":[{"text":prompt}]}),
        );
    } else if let Some(messages) = object
        .get_mut("messages")
        .and_then(serde_json::Value::as_array_mut)
    {
        messages.insert(0, serde_json::json!({"role":"system","content":prompt}));
    } else {
        object.insert(
            "messages".to_owned(),
            serde_json::json!([{"role":"system","content":prompt}]),
        );
    }
    Some(next)
}

fn pipeline_transform_body(
    body: &serde_json::Value,
    prompt: Option<&str>,
    input: &str,
    protocol: ProviderProtocol,
) -> Option<serde_json::Value> {
    let mut next = body.clone();
    let object = next.as_object_mut()?;
    if protocol == ProviderProtocol::Anthropic {
        match prompt {
            Some(prompt) if !prompt.is_empty() => {
                object.insert(
                    "system".to_owned(),
                    serde_json::Value::String(prompt.to_owned()),
                );
            }
            _ => {
                object.remove("system");
            }
        }
        object.insert(
            "messages".to_owned(),
            serde_json::json!([{"role":"user","content":input}]),
        );
        object.remove("input");
        object.remove("contents");
    } else if object.contains_key("input") {
        let mut turns = Vec::new();
        if let Some(prompt) = prompt.filter(|prompt| !prompt.is_empty()) {
            turns.push(serde_json::json!({"role":"system","content":prompt}));
        }
        turns.push(serde_json::json!({"role":"user","content":input}));
        object.insert("input".to_owned(), serde_json::Value::Array(turns));
        object.remove("messages");
        object.remove("contents");
    } else if object.contains_key("contents") {
        let text = prompt
            .filter(|prompt| !prompt.is_empty())
            .map_or_else(|| input.to_owned(), |prompt| format!("{prompt}\n\n{input}"));
        object.insert(
            "contents".to_owned(),
            serde_json::json!([{"role":"user","parts":[{"text":text}]}]),
        );
        object.remove("messages");
        object.remove("input");
    } else {
        let mut turns = Vec::new();
        if let Some(prompt) = prompt.filter(|prompt| !prompt.is_empty()) {
            turns.push(serde_json::json!({"role":"system","content":prompt}));
        }
        turns.push(serde_json::json!({"role":"user","content":input}));
        object.insert("messages".to_owned(), serde_json::Value::Array(turns));
        object.remove("input");
        object.remove("contents");
    }
    Some(next)
}

async fn execute_fusion_panel_target(
    target_index: usize,
    target: ContextRelaySummaryTarget,
    mut body: serde_json::Value,
    control: Option<control_plane::ControlPlane>,
    identity: Option<policy::ClientIdentity>,
    attribution: native_usage::UsageAttribution,
    credits_mode: AntigravityCreditsMode,
) -> Result<FusionPanelAnswer, InternalTargetFailure> {
    let object = body
        .as_object_mut()
        .ok_or_else(InternalTargetFailure::internal)?;
    object.remove("tools");
    object.remove("tool_choice");
    object.remove("stream_options");
    if matches!(
        target.protocol,
        ProviderProtocol::Gemini | ProviderProtocol::Antigravity
    ) {
        object.remove("stream");
    } else {
        object.insert("stream".to_owned(), serde_json::Value::Bool(false));
    }
    let translate_anthropic = target.protocol == ProviderProtocol::OpenAiToAnthropic;
    let translate_antigravity = target.protocol == ProviderProtocol::OpenAiToAntigravity;
    let antigravity = matches!(
        target.protocol,
        ProviderProtocol::Antigravity | ProviderProtocol::OpenAiToAntigravity
    );
    let encoded = if translate_antigravity {
        antigravity_translation::request(
            &body,
            &target.model,
            target.antigravity_project.as_deref(),
            None,
        )
        .and_then(|value| serde_json::to_vec(&value).map_err(|_| ()))
    } else if translate_anthropic {
        translation::request(&body, &target.model)
            .and_then(|value| serde_json::to_vec(&value).map_err(|_| ()))
    } else {
        if !matches!(
            target.protocol,
            ProviderProtocol::Gemini | ProviderProtocol::Antigravity
        ) {
            body["model"] = serde_json::Value::String(target.model.clone());
        }
        serde_json::to_vec(&body).map_err(|_| ())
    };
    let mut payload = encoded.map_err(|_| InternalTargetFailure::internal())?;
    if antigravity {
        payload =
            antigravity_credits_payload(&payload, credits_mode == AntigravityCreditsMode::Always)
                .map_err(|_| InternalTargetFailure::internal())?;
    }
    let mut upstream = target.upstream.clone();
    if target.protocol == ProviderProtocol::Gemini {
        upstream.set_path(&format!(
            "{}/{}:generateContent",
            upstream.path(),
            target.model
        ));
    } else if antigravity {
        upstream.set_query(Some("alt=sse"));
    }
    let availability_permit = if let Some(availability) = &target.availability {
        match availability
            .try_acquire(&target.model)
            .await
            .map_err(|_| InternalTargetFailure::internal())?
        {
            availability::AvailabilityDecision::Permit(permit) => Some(permit),
            availability::AvailabilityDecision::Blocked { .. } => {
                return Err(InternalTargetFailure::internal())
            }
        }
    } else {
        None
    };
    let circuit_permit = if let Some(circuit) = &target.circuit {
        match circuit
            .try_acquire()
            .await
            .map_err(|_| InternalTargetFailure::internal())?
        {
            circuit::CircuitDecision::Permit(permit) => Some(permit),
            circuit::CircuitDecision::Open { .. } => return Err(InternalTargetFailure::internal()),
        }
    } else {
        None
    };
    let accounting_attempt = match (control, identity) {
        (Some(control), Some(identity)) => {
            let (event_id, prices) = match control
                .begin_native_usage(
                    &identity,
                    &target.provider_name,
                    &target.model,
                    None,
                    &attribution,
                )
                .await
            {
                Ok(attempt) => attempt,
                Err(_) => {
                    if let (Some(circuit), Some(permit)) = (&target.circuit, circuit_permit) {
                        circuit.record_ignored(permit).await;
                    }
                    return Err(InternalTargetFailure::internal());
                }
            };
            Some(UsageAttempt::Native {
                control,
                identity,
                attribution,
                provider: target.provider_name.clone(),
                model: target.model.clone(),
                prices,
                event_id,
            })
        }
        _ => None,
    };
    let build_request = |include_project: bool, request_payload: &[u8]| {
        let mut request = target
            .client
            .post(upstream.clone())
            .header(header::CONTENT_TYPE, "application/json")
            .body(request_payload.to_vec());
        request = match target.auth_scheme {
            ProviderAuthScheme::Bearer => {
                request.header(header::AUTHORIZATION, target.provider_key.clone())
            }
            ProviderAuthScheme::XApiKey => request.header("x-api-key", target.provider_key.clone()),
            ProviderAuthScheme::XGoogApiKey => {
                request.header("x-goog-api-key", target.provider_key.clone())
            }
            ProviderAuthScheme::None => request,
            ProviderAuthScheme::Auto => return None,
        };
        if matches!(
            target.protocol,
            ProviderProtocol::Anthropic | ProviderProtocol::OpenAiToAnthropic
        ) {
            request = request.header("anthropic-version", "2023-06-01");
        }
        if antigravity {
            request = request
                .header(header::ACCEPT, "text/event-stream")
                .header(header::USER_AGENT, ANTIGRAVITY_CLI_USER_AGENT);
            if include_project {
                if let Some(project) = target.antigravity_project.as_deref() {
                    request = request.header("x-goog-user-project", project);
                }
            }
        }
        Some(request.headers(target.custom_headers.clone()))
    };
    let _load_guard = ProviderLoadGuard::new(target.in_flight.clone());
    let request = build_request(true, &payload).ok_or_else(InternalTargetFailure::internal)?;
    let response = match tokio::time::timeout(HEADER_TIMEOUT, request.send()).await {
        Ok(Ok(response)) => response,
        _ => {
            let _ = record_internal_provider_health(
                &target,
                circuit_permit,
                availability_permit,
                None,
                None,
                None,
            )
            .await;
            return Err(InternalTargetFailure::internal());
        }
    };
    let response = if antigravity
        && response.status() == StatusCode::FORBIDDEN
        && target.antigravity_project.is_some()
    {
        let request = build_request(false, &payload).ok_or_else(InternalTargetFailure::internal)?;
        match tokio::time::timeout(HEADER_TIMEOUT, request.send()).await {
            Ok(Ok(response)) => response,
            _ => {
                let _ = record_internal_provider_health(
                    &target,
                    circuit_permit,
                    availability_permit,
                    None,
                    None,
                    None,
                )
                .await;
                return Err(InternalTargetFailure::internal());
            }
        }
    } else {
        response
    };
    let mut response = inspect_provider_response(response).await;
    if antigravity
        && credits_mode == AntigravityCreditsMode::Retry
        && response.status() == StatusCode::TOO_MANY_REQUESTS
        && resilience::antigravity_credits_retry_eligible(response.error_body())
    {
        let credits_payload = antigravity_credits_payload(&payload, true)
            .map_err(|_| InternalTargetFailure::internal())?;
        if let Some(request) = build_request(false, &credits_payload) {
            if let Ok(Ok(retry)) =
                tokio::time::timeout(ANTIGRAVITY_CREDITS_RETRY_TIMEOUT, request.send()).await
            {
                response = inspect_provider_response(retry).await;
            }
        }
    }
    if !response.status().is_success() {
        let _ = record_internal_provider_health(
            &target,
            circuit_permit,
            availability_permit,
            Some(response.status()),
            Some(response.headers()),
            response.error_body(),
        )
        .await;
        return Err(InternalTargetFailure::upstream(response.status()));
    }
    let response = response
        .into_streaming()
        .ok_or_else(InternalTargetFailure::internal)?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BODY_BYTES as u64)
    {
        let _ = record_internal_provider_health(
            &target,
            circuit_permit,
            availability_permit,
            Some(StatusCode::OK),
            None,
            None,
        )
        .await;
        return Err(InternalTargetFailure::internal());
    }
    let read = async move {
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
        _ => {
            let _ = record_internal_provider_health(
                &target,
                circuit_permit,
                availability_permit,
                None,
                None,
                None,
            )
            .await;
            return Err(InternalTargetFailure::internal());
        }
    };
    if record_internal_provider_health(
        &target,
        circuit_permit,
        availability_permit,
        Some(StatusCode::OK),
        None,
        None,
    )
    .await
    .is_err()
    {
        return Err(InternalTargetFailure::internal());
    }
    let (value, usage) = if antigravity {
        let translated = antigravity_translation::response(&bytes, &target.model)
            .map_err(|_| InternalTargetFailure::internal())?
            .value;
        let usage = accounting::ChatUsage::from_response(&translated).ok();
        (translated, usage)
    } else {
        let raw: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| InternalTargetFailure::internal())?;
        let usage = match target.protocol {
            ProviderProtocol::OpenAiResponses => {
                accounting::ChatUsage::from_responses_response(&raw)
            }
            ProviderProtocol::Anthropic | ProviderProtocol::OpenAiToAnthropic => {
                accounting::ChatUsage::from_anthropic_response(&raw)
            }
            ProviderProtocol::Gemini => accounting::ChatUsage::from_gemini_response(&raw),
            _ => accounting::ChatUsage::from_response(&raw),
        }
        .ok();
        let value = if translate_anthropic {
            translation::response(&raw).map_err(|_| InternalTargetFailure::internal())?
        } else {
            raw
        };
        (value, usage)
    };
    if let Some(accounting) = accounting_attempt {
        let usage = usage.as_ref().ok_or_else(InternalTargetFailure::internal)?;
        if accounting.record(None, usage).await.is_err() {
            return Err(InternalTargetFailure::internal());
        }
    }
    let text = context_relay_response_text(&value).trim().to_owned();
    if text.is_empty() {
        return Err(InternalTargetFailure::internal());
    }
    Ok(FusionPanelAnswer { target_index, text })
}

async fn prepare_fusion(
    state: &ProxyState,
    route: &ModelRoute,
    eligible: &[&ModelTarget],
    body: &serde_json::Value,
    native_usage_identity: Option<&policy::ClientIdentity>,
    attribution: &native_usage::UsageAttribution,
    product_usage_accounting: bool,
) -> Result<FusionPreparation, FusionFailure> {
    let judge_index = route
        .fusion
        .judge_model
        .is_empty()
        .then_some(0)
        .or_else(|| {
            eligible.iter().position(|target| {
                target.model == route.fusion.judge_model
                    || target.provider_id.as_deref().is_some_and(|provider| {
                        format!("{provider}/{}", target.model) == route.fusion.judge_model
                    })
            })
        })
        .unwrap_or(0);
    let direct = || FusionPreparation {
        judge_body: None,
        attempt_order: fusion_attempt_order(eligible, judge_index, &[]),
    };
    if eligible.len() == 1 || fusion_request_has_tools(body) {
        return Ok(direct());
    }
    if product_usage_accounting {
        return Err(FusionFailure {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "Fusion requires Rust-native usage accounting",
        });
    }
    let mut pending = FuturesUnordered::new();
    for (target_index, target) in eligible.iter().enumerate() {
        if target.credential_expires_at_unix > 0
            && unix_time_ms() / 1_000 >= target.credential_expires_at_unix
        {
            continue;
        }
        let Some(target) = internal_target_from_model(route, target) else {
            continue;
        };
        let body = body.clone();
        let control = state.control_plane.clone();
        let identity = native_usage_identity.cloned();
        let attribution = attribution.clone();
        let credits_mode = state.antigravity_credits_mode;
        pending.push(tokio::spawn(async move {
            execute_fusion_panel_target(
                target_index,
                target,
                body,
                control,
                identity,
                attribution,
                credits_mode,
            )
            .await
        }));
    }
    let minimum = usize::try_from(route.fusion.min_panel)
        .unwrap_or(eligible.len())
        .clamp(1, eligible.len());
    let hard_deadline =
        tokio::time::Instant::now() + Duration::from_millis(route.fusion.panel_timeout_ms);
    let mut grace_deadline = None;
    let mut answers = Vec::new();
    while !pending.is_empty() {
        let deadline = grace_deadline.unwrap_or(hard_deadline).min(hard_deadline);
        let next = match tokio::time::timeout_at(deadline, pending.next()).await {
            Ok(next) => next,
            Err(_) => break,
        };
        if let Some(Ok(Ok(answer))) = next {
            answers.push(answer);
            if answers.len() >= minimum && grace_deadline.is_none() {
                grace_deadline = Some(
                    tokio::time::Instant::now()
                        + Duration::from_millis(route.fusion.straggler_grace_ms),
                );
            }
        }
    }
    if answers.is_empty() {
        return Err(FusionFailure {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "All fusion panel models failed",
        });
    }
    answers.sort_by_key(|answer| answer.target_index);
    let judge_index = if route.fusion.judge_model.is_empty()
        && !answers
            .iter()
            .any(|answer| answer.target_index == judge_index)
    {
        answers[0].target_index
    } else {
        judge_index
    };
    let Some(judge_body) = fusion_append_judge_prompt(body, fusion_judge_prompt(&answers)) else {
        return Err(FusionFailure {
            status: StatusCode::BAD_REQUEST,
            message: "Fusion is incompatible with this request body",
        });
    };
    Ok(FusionPreparation {
        judge_body: Some(judge_body),
        attempt_order: fusion_attempt_order(eligible, judge_index, &answers),
    })
}

async fn prepare_pipeline(
    state: &ProxyState,
    route: &ModelRoute,
    eligible: &[&ModelTarget],
    body: &serde_json::Value,
    native_usage_identity: Option<&policy::ClientIdentity>,
    attribution: &native_usage::UsageAttribution,
    product_usage_accounting: bool,
) -> Result<PipelinePreparation, PipelineFailure> {
    if product_usage_accounting && eligible.len() > 1 {
        return Err(PipelineFailure {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "Pipeline requires Rust-native usage accounting",
        });
    }
    let final_index = eligible.len() - 1;
    let attempt_order = pipeline_attempt_order(final_index, eligible.len());
    if eligible.len() == 1 {
        let body = pipeline_prepend_system_instruction(
            body,
            eligible[0].prompt.as_deref(),
            route.protocol,
        )
        .ok_or(PipelineFailure {
            status: StatusCode::BAD_REQUEST,
            message: "Pipeline is incompatible with this request body",
        })?;
        return Ok(PipelinePreparation {
            body,
            attempt_order,
        });
    }
    let mut previous = String::new();
    for (index, target) in eligible[..final_index].iter().enumerate() {
        if target.credential_expires_at_unix > 0
            && unix_time_ms() / 1_000 >= target.credential_expires_at_unix
        {
            return Err(PipelineFailure {
                status: StatusCode::SERVICE_UNAVAILABLE,
                message: "Pipeline provider credential expired",
            });
        }
        let step_body = if index == 0 {
            pipeline_prepend_system_instruction(body, target.prompt.as_deref(), route.protocol)
        } else {
            pipeline_transform_body(body, target.prompt.as_deref(), &previous, route.protocol)
        }
        .ok_or(PipelineFailure {
            status: StatusCode::BAD_REQUEST,
            message: "Pipeline is incompatible with this request body",
        })?;
        let target = internal_target_from_model(route, target).ok_or(PipelineFailure {
            status: StatusCode::BAD_GATEWAY,
            message: "Pipeline step could not be prepared",
        })?;
        let mut retry = 0;
        let answer = loop {
            match execute_fusion_panel_target(
                index,
                target.clone(),
                step_body.clone(),
                state.control_plane.clone(),
                native_usage_identity.cloned(),
                attribution.clone(),
                state.antigravity_credits_mode,
            )
            .await
            {
                Ok(answer) => break answer,
                Err(failure) if failure.retryable() && retry < route.pipeline.max_retries => {
                    retry += 1;
                    tokio::time::sleep(Duration::from_millis(route.pipeline.retry_delay_ms)).await;
                }
                Err(failure) => {
                    return Err(PipelineFailure {
                        status: failure.status.unwrap_or(StatusCode::BAD_GATEWAY),
                        message: "Pipeline intermediate step failed",
                    });
                }
            }
        };
        previous = answer.text;
    }
    let body = pipeline_transform_body(
        body,
        eligible[final_index].prompt.as_deref(),
        &previous,
        route.protocol,
    )
    .ok_or(PipelineFailure {
        status: StatusCode::BAD_REQUEST,
        message: "Pipeline is incompatible with this request body",
    })?;
    Ok(PipelinePreparation {
        body,
        attempt_order,
    })
}

#[allow(clippy::too_many_arguments)]
fn spawn_context_relay_summary(
    control: control_plane::ControlPlane,
    combo_id: String,
    session_id: String,
    summary_target: ContextRelaySummaryTarget,
    history: String,
    source_model: String,
    message_count: usize,
    expires_at_unix_ms: i64,
    handoff_known_absent: bool,
) {
    tokio::spawn(async move {
        if !handoff_known_absent {
            match control.context_relay_handoff(&combo_id, &session_id).await {
                Ok(Some(_)) => return,
                Ok(None) => {}
                Err(_) => {
                    eprintln!("context relay handoff state unavailable");
                    return;
                }
            }
        }
        let generation_lease = match control
            .acquire_context_relay_generation(&combo_id, &session_id)
            .await
        {
            Ok(Some(lease)) => lease,
            Ok(None) => return,
            Err(_) => {
                eprintln!("context relay generation state unavailable");
                return;
            }
        };
        async {
            let usage_attempt = match control
                .begin_context_relay_usage(
                    &summary_target.tenant_id,
                    &summary_target.provider_name,
                    &summary_target.model,
                )
                .await
            {
                Ok(attempt) => attempt,
                Err(_) => {
                    eprintln!("context relay usage accounting unavailable");
                    return;
                }
            };
            let availability_permit = if let Some(availability) = &summary_target.availability {
                match availability.try_acquire(&summary_target.model).await {
                    Ok(availability::AvailabilityDecision::Permit(permit)) => Some(permit),
                    Ok(availability::AvailabilityDecision::Blocked { .. }) => return,
                    Err(_) => {
                        eprintln!("context relay provider availability unavailable");
                        return;
                    }
                }
            } else {
                None
            };
            let circuit_permit = if let Some(circuit) = &summary_target.circuit {
                match circuit.try_acquire().await {
                    Ok(circuit::CircuitDecision::Permit(permit)) => Some(permit),
                    Ok(circuit::CircuitDecision::Open { .. }) => return,
                    Err(_) => {
                        eprintln!("context relay provider health unavailable");
                        return;
                    }
                }
            } else {
                None
            };
            let _provider_load = ProviderLoadGuard::new(summary_target.in_flight.clone());
            let outcome = tokio::time::timeout(
                CONTEXT_RELAY_SUMMARY_DEADLINE,
                generate_context_relay_summary(
                    &summary_target,
                    history,
                    source_model,
                    message_count,
                ),
            )
            .await
            .unwrap_or(ContextRelaySummaryOutcome::TransportFailure);
            let health = match &outcome {
                ContextRelaySummaryOutcome::Generated(_)
                | ContextRelaySummaryOutcome::InvalidSuccess => {
                    record_internal_provider_health(
                        &summary_target,
                        circuit_permit,
                        availability_permit,
                        Some(StatusCode::OK),
                        None,
                        None,
                    )
                    .await
                }
                ContextRelaySummaryOutcome::Rejected {
                    status,
                    headers,
                    error_body,
                } => {
                    record_internal_provider_health(
                        &summary_target,
                        circuit_permit,
                        availability_permit,
                        Some(*status),
                        Some(headers),
                        error_body.as_deref(),
                    )
                    .await
                }
                ContextRelaySummaryOutcome::TransportFailure => {
                    record_internal_provider_health(
                        &summary_target,
                        circuit_permit,
                        availability_permit,
                        None,
                        None,
                        None,
                    )
                    .await
                }
            };
            if health.is_err() {
                eprintln!("context relay provider health accounting unavailable");
                return;
            }
            let ContextRelaySummaryOutcome::Generated(generated) = outcome else {
                return;
            };
            if let Some(attempt) = usage_attempt {
                if control
                    .record_context_relay_usage(
                        attempt,
                        &summary_target.tenant_id,
                        &summary_target.provider_name,
                        &summary_target.model,
                        &generated.usage,
                    )
                    .await
                    .is_err()
                {
                    eprintln!("context relay usage accounting unavailable");
                    return;
                }
            }
            if control
                .record_context_relay_handoff(
                    &combo_id,
                    &session_id,
                    &generated.handoff,
                    &generated.summary_model,
                    expires_at_unix_ms,
                )
                .await
                .is_err()
            {
                eprintln!("context relay handoff persistence unavailable");
            }
        }
        .await;
        if control
            .release_context_relay_generation(&generation_lease)
            .await
            .is_err()
        {
            eprintln!("context relay generation lease release unavailable");
        }
    });
}

fn inject_context_relay_handoff(
    body: &mut serde_json::Value,
    protocol: ProviderProtocol,
    previous_model: &str,
    current_model: &str,
    handoff: Option<&control_plane::ContextRelayHandoff>,
) -> Result<(), ()> {
    let object = body.as_object_mut().ok_or(())?;
    let previous_model = context_relay_xml(previous_model);
    let current_model = context_relay_xml(current_model);
    let content = handoff.map_or_else(
        || format!(
            "<context_handoff>\n<transfer_reason>Model routing: {previous_model} → {current_model}</transfer_reason>\n<previous_model>{previous_model}</previous_model>\n<current_model>{current_model}</current_model>\n<note>No prior-session summary is available for this handoff. Use only the conversation context supplied by the client and do not invent missing details.</note>\n</context_handoff>"
        ),
        |handoff| {
            let decisions = handoff
                .key_decisions
                .iter()
                .map(|decision| format!("  - {}", context_relay_xml(decision)))
                .collect::<Vec<_>>()
                .join("\n");
            let entities = handoff
                .active_entities
                .iter()
                .map(|entity| context_relay_xml(entity))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "<context_handoff>\n<transfer_reason>Model routing: {previous_model} → {current_model}</transfer_reason>\n<previous_model>{previous_model}</previous_model>\n<current_model>{current_model}</current_model>\n<session_summary>{}</session_summary>\n<task_progress>{}</task_progress>\n<key_decisions>\n{decisions}\n</key_decisions>\n<active_context>{entities}</active_context>\n<messages_processed>{}</messages_processed>\n<summary_source_model>{}</summary_source_model>\n</context_handoff>\n\nContinue from the structured summary without inventing details that are not present in it or in the client conversation.",
                context_relay_xml(&handoff.summary),
                context_relay_xml(&handoff.task_progress),
                handoff.message_count,
                context_relay_xml(&handoff.source_model),
            )
        },
    );
    match protocol {
        ProviderProtocol::OpenAiResponses => {
            let existing = object
                .get("instructions")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty());
            object.insert(
                "instructions".to_owned(),
                serde_json::Value::String(existing.map_or_else(
                    || content.clone(),
                    |existing| format!("{content}\n\n{existing}"),
                )),
            );
        }
        ProviderProtocol::Anthropic => {
            let block = serde_json::json!({"type":"text", "text":content});
            let system = object.remove("system");
            let next = match system {
                Some(serde_json::Value::Array(mut blocks)) => {
                    blocks.push(block);
                    serde_json::Value::Array(blocks)
                }
                Some(serde_json::Value::String(existing)) if !existing.is_empty() => {
                    serde_json::json!([{"type":"text", "text":existing}, block])
                }
                _ => serde_json::Value::Array(vec![block]),
            };
            object.insert("system".to_owned(), next);
        }
        ProviderProtocol::Gemini | ProviderProtocol::Antigravity => {
            let instruction = object
                .entry("systemInstruction")
                .or_insert_with(|| serde_json::json!({"parts":[]}));
            let parts = instruction
                .as_object_mut()
                .and_then(|instruction| {
                    instruction
                        .entry("parts")
                        .or_insert_with(|| serde_json::json!([]))
                        .as_array_mut()
                })
                .ok_or(())?;
            parts.push(serde_json::json!({"text":content}));
        }
        ProviderProtocol::OpenAi
        | ProviderProtocol::OpenAiToAnthropic
        | ProviderProtocol::OpenAiToAntigravity => {
            let messages = object
                .entry("messages")
                .or_insert_with(|| serde_json::json!([]))
                .as_array_mut()
                .ok_or(())?;
            messages.insert(0, serde_json::json!({"role":"system", "content":content}));
        }
        ProviderProtocol::OpenAiEmbeddings | ProviderProtocol::CohereRerank => return Err(()),
    }
    Ok(())
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

fn usage_attribution(
    headers: &HeaderMap,
    body: &serde_json::Value,
) -> Result<native_usage::UsageAttribution, ()> {
    fn bounded(value: &str, max_bytes: usize) -> &str {
        if value.len() <= max_bytes {
            return value;
        }
        let mut end = max_bytes;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        &value[..end]
    }

    fn normalized(value: &str, max_bytes: usize, lowercase: bool) -> Result<Option<String>, ()> {
        let value = value.trim();
        if value.is_empty() {
            return Ok(None);
        }
        if value.chars().any(char::is_control) {
            return Err(());
        }
        let value = if lowercase {
            value.to_lowercase()
        } else {
            value.to_owned()
        };
        Ok(Some(bounded(&value, max_bytes).to_owned()))
    }

    let body_user = body.get("user").and_then(serde_json::Value::as_str);
    let header_user = headers
        .get("x-red-router-end-user")
        .map(|value| value.to_str().map_err(|_| ()))
        .transpose()?;
    let end_user = body_user
        .or(header_user)
        .map(|value| normalized(value, 128, false))
        .transpose()?
        .flatten();

    let mut tags = Vec::new();
    let body_tags = body
        .pointer("/metadata/tags")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str);
    let header_tags = headers
        .get("x-red-router-tags")
        .map(|value| value.to_str().map_err(|_| ()))
        .transpose()?
        .into_iter()
        .flat_map(|value| value.split(','));
    for tag in body_tags.chain(header_tags) {
        let Some(tag) = normalized(tag, 32, true)? else {
            continue;
        };
        if !tags.iter().any(|existing| existing == &tag) {
            tags.push(tag);
            if tags.len() == 20 {
                break;
            }
        }
    }
    Ok(native_usage::UsageAttribution { end_user, tags })
}

async fn proxy_request(
    state: ProxyState,
    request: Request,
    protocol: ProviderProtocol,
    gemini: Option<(String, bool)>,
) -> Response {
    let original_headers = request.headers().clone();
    let (selected_product, product_candidate, product_access) = if state.product_client_keys {
        match authenticate_product_request(&state, request.headers(), protocol).await {
            Ok((access, index, candidate)) => (index, Some(candidate), Some(access)),
            Err(response) => return *response,
        }
    } else {
        (0, None, None)
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
    let product_usage_accounting = state
        .product_connection
        .as_ref()
        .is_some_and(|c| c.usage_accounting_enabled());
    let native_usage_identity = policy
        .identity()
        .filter(|identity| identity.usage_quota.is_some() || state.native_usage_reporting)
        .cloned();
    let native_usage_attribution = if native_usage_identity.is_some() {
        match usage_attribution(&original_headers, &parsed) {
            Ok(attribution) => attribution,
            Err(()) => return error(StatusCode::BAD_REQUEST, "Invalid usage attribution"),
        }
    } else {
        native_usage::UsageAttribution::default()
    };
    let usage_accounting = product_usage_accounting || native_usage_identity.is_some();
    let native_rerank_accounting = protocol == ProviderProtocol::CohereRerank
        && native_usage_identity.is_some()
        && !product_usage_accounting;
    if product_usage_accounting && !state.product_client_keys {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Usage accounting requires product client keys",
        );
    }
    let accounting_stream = match protocol {
        ProviderProtocol::OpenAi
        | ProviderProtocol::OpenAiResponses
        | ProviderProtocol::Anthropic => {
            parsed.get("stream").and_then(serde_json::Value::as_bool) == Some(true)
        }
        ProviderProtocol::Gemini => gemini.as_ref().is_some_and(|(_, stream)| *stream),
        ProviderProtocol::Antigravity => true,
        _ => false,
    };
    let usage_protocol_supported = matches!(
        protocol,
        ProviderProtocol::OpenAi
            | ProviderProtocol::OpenAiResponses
            | ProviderProtocol::OpenAiEmbeddings
            | ProviderProtocol::Anthropic
            | ProviderProtocol::Gemini
            | ProviderProtocol::Antigravity
    ) || native_rerank_accounting;
    if usage_accounting
        && (!usage_protocol_supported
            || (protocol == ProviderProtocol::OpenAi
                && (!matches!(
                    parsed.get("stream"),
                    None | Some(serde_json::Value::Bool(_))
                ) || (accounting_stream
                    && parsed
                        .pointer("/stream_options/include_usage")
                        .and_then(serde_json::Value::as_bool)
                        != Some(true))))
            || (protocol == ProviderProtocol::OpenAiResponses
                && !matches!(
                    parsed.get("stream"),
                    None | Some(serde_json::Value::Bool(_))
                ))
            || (protocol == ProviderProtocol::OpenAiEmbeddings && parsed.get("stream").is_some())
            || (protocol == ProviderProtocol::Anthropic
                && !matches!(
                    parsed.get("stream"),
                    None | Some(serde_json::Value::Bool(_))
                ))
            || parsed
                .get("service_tier")
                .is_some_and(|v| !v.is_null() && v.as_str() != Some("default")))
    {
        return error(
            StatusCode::BAD_REQUEST,
            "Usage accounting requires a supported protocol with verifiable terminal usage, all on the default tier",
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
    // Resolve the historical combo/name spelling to the durable combo ID before
    // affinity, relay, quota and accounting use it. Keep the original for policy checks.
    let requested_model = model.clone();
    let has_route = |name: &str| {
        control_routes.as_ref().is_some_and(|routes| {
            routes
                .get(name)
                .is_some_and(|route| policy.tenant_allowed(&route.tenant_id))
        }) || state
            .routes
            .get(name)
            .is_some_and(|route| policy.tenant_allowed(&route.tenant_id))
    };
    let alias_route =
        if !has_route(&model) && state.product_combo.is_none() && !state.product_client_keys {
            match &state.control_plane {
                Some(control) => match control.model_aliases_snapshot().await {
                    Ok(aliases) => aliases
                        .resolve(
                            policy
                                .identity()
                                .map_or("red", |identity| identity.tenant_id.as_ref()),
                            &model,
                        )
                        .map(str::to_owned),
                    Err(_) => {
                        return error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "Model alias routing unavailable",
                        )
                    }
                },
                None => None,
            }
        } else {
            None
        };
    let model = if let Some(alias) = alias_route {
        alias
    } else if !has_route(&model) {
        model
            .strip_prefix("combo/")
            .filter(|name| has_route(name))
            .map(str::to_owned)
            .unwrap_or(model)
    } else {
        model
    };
    let route = control_routes
        .as_ref()
        .and_then(|routes| routes.get(&model))
        .or_else(|| state.routes.get(&model))
        .filter(|route| policy.tenant_allowed(&route.tenant_id));
    if route.is_some_and(|route| {
        route
            .public_model_alias
            .as_deref()
            .is_some_and(|name| name != requested_model)
    }) {
        return error(StatusCode::NOT_FOUND, "Unknown model alias");
    }
    if state.product_combo.is_none()
        && !if route.is_some_and(|route| route.public_model_alias.is_some()) {
            policy.route_allowed(&requested_model)
        } else if route.is_some() {
            policy.combo_allowed(&requested_model)
        } else {
            policy.route_allowed(&model)
        }
    {
        return error(StatusCode::FORBIDDEN, "Model or combo is not allowed");
    }
    let context_relay_config = route
        .filter(|route| route.strategy == RouteStrategy::ContextRelay)
        .map(|route| &route.context_relay);
    let context_relay_session_id = if context_relay_config.is_some() {
        if state.control_plane.is_none() {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Context relay persistence is unavailable",
            );
        }
        match parse_context_relay_session_id(&original_headers) {
            Ok(session_id) => session_id,
            Err(()) => return error(StatusCode::BAD_REQUEST, "Invalid context relay session id"),
        }
    } else {
        None
    };
    if (route.is_none()
        && (control_routes_authoritative
            || !state.routes.is_empty()
            || (protocol != ProviderProtocol::OpenAi && !direct_product_model)))
        || route.is_some_and(|route| {
            route.protocol != protocol
                && !(protocol == ProviderProtocol::OpenAi
                    && matches!(
                        route.protocol,
                        ProviderProtocol::OpenAiToAnthropic | ProviderProtocol::OpenAiToAntigravity
                    ))
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
    if route.is_none()
        && live_provider
            .as_ref()
            .is_some_and(|provider| !policy.tenant_allowed(&provider.tenant_id))
    {
        return error(StatusCode::NOT_FOUND, "Unknown model route");
    }
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
    let mut eligible: Vec<_> = route.map_or_else(Vec::new, |route| {
        route
            .targets
            .iter()
            .filter(|target| {
                (if state.product_combo.is_some() {
                    policy.target_allowed(target.product_model.as_deref().unwrap_or(&target.model))
                } else {
                    route.target_allowed(policy, &requested_model, target)
                }) && policy.provider_allowed(target.provider_id.as_deref())
            })
            .collect()
    });
    if route.is_none() && !policy.target_allowed(&model) {
        return error(StatusCode::FORBIDDEN, "Model is not allowed");
    }
    if route.is_some() && eligible.is_empty() {
        return error(StatusCode::FORBIDDEN, "No permitted route target");
    }
    if let Some(threshold_ppm) = match &state.control_plane {
        Some(control) => control.quota_preflight_threshold_ppm().await,
        None => None,
    } {
        let now = unix_time_ms();
        eligible.retain(|target| quota_preflight_allows(target, now, threshold_ppm));
        if route.is_some() && eligible.is_empty() {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "All permitted route targets are below the quota cutoff",
            );
        }
    }
    if let Some(target) = product_target {
        parsed["model"] = serde_json::Value::String(target);
    }
    // Validate translation before sending any attempt, so fallback cannot
    // silently discard fields that were accepted by a different provider.
    let translation_target = eligible
        .iter()
        .find(|target| target.protocol == ProviderProtocol::OpenAiToAnthropic);
    let _translated_validation = if let Some(target) = translation_target {
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
    let translate_antigravity_route = eligible
        .iter()
        .any(|target| target.protocol == ProviderProtocol::OpenAiToAntigravity);
    let mut antigravity_history_ids = Vec::new();
    if translate_antigravity_route {
        let target = eligible
            .iter()
            .find(|target| target.protocol == ProviderProtocol::OpenAiToAntigravity)
            .expect("checked Antigravity translation target");
        antigravity_history_ids = match antigravity_translation::historical_tool_call_ids(&parsed) {
            Ok(ids) => ids,
            Err(_) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "Unsupported OpenAI tool history for Antigravity translation",
                )
            }
        };
        if antigravity_translation::request(&parsed, &target.model, None, None).is_err() {
            return error(
                StatusCode::BAD_REQUEST,
                "Unsupported OpenAI request for Antigravity translation",
            );
        }
    }
    let request_allowed = if let (Some(identity), Some(control)) =
        (policy.identity(), state.control_plane.as_ref())
    {
        match control.admit_client_request(identity).await {
            Ok(Some(allowed)) => allowed,
            Ok(None) => policy.allow_request(),
            Err(reason) => {
                eprintln!("client request rate-limit accounting failed: {reason}");
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Client rate-limit accounting unavailable",
                );
            }
        }
    } else {
        policy.allow_request()
    };
    if !request_allowed {
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
    let fusion_preparation = match route.filter(|route| route.strategy == RouteStrategy::Fusion) {
        Some(route) => match prepare_fusion(
            &state,
            route,
            &eligible,
            &parsed,
            native_usage_identity.as_ref(),
            &native_usage_attribution,
            product_usage_accounting,
        )
        .await
        {
            Ok(preparation) => Some(preparation),
            Err(failure) => return error(failure.status, failure.message),
        },
        None => None,
    };
    let pipeline_preparation = match route.filter(|route| route.strategy == RouteStrategy::Pipeline)
    {
        Some(route) => match prepare_pipeline(
            &state,
            route,
            &eligible,
            &parsed,
            native_usage_identity.as_ref(),
            &native_usage_attribution,
            product_usage_accounting,
        )
        .await
        {
            Ok(preparation) => Some(preparation),
            Err(failure) => return error(failure.status, failure.message),
        },
        None => None,
    };
    if let Some(judge_body) = fusion_preparation
        .as_ref()
        .and_then(|preparation| preparation.judge_body.clone())
    {
        parsed = judge_body;
    }
    if let Some(preparation) = pipeline_preparation.as_ref() {
        parsed = preparation.body.clone();
    }
    let cache_affinity_key = route
        .filter(|route| route.strategy == RouteStrategy::CacheOptimized)
        .and_then(|_| prompt_cache_affinity_key(&parsed));
    // Alias pools are direct priority lists, not the fixed-size combo strategy deck.
    let direct_alias = route.is_some_and(|route| route.public_model_alias.is_some());
    let mut attempt_order = route
        .filter(|route| route.public_model_alias.is_none())
        .map(|route| route.attempt_order(&eligible, cache_affinity_key.as_deref()));
    if let Some(preparation) = fusion_preparation {
        attempt_order = Some(preparation.attempt_order);
    }
    if let Some(preparation) = pipeline_preparation {
        attempt_order = Some(preparation.attempt_order);
    }
    let context_relay_previous = match (
        route.filter(|route| route.strategy == RouteStrategy::ContextRelay),
        context_relay_session_id.as_deref(),
        state.control_plane.as_ref(),
    ) {
        (Some(_), Some(session_id), Some(control)) => {
            match control.context_relay_session(&model, session_id).await {
                Ok(previous) => previous,
                Err(_) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Context relay state unavailable",
                    )
                }
            }
        }
        _ => None,
    };
    let context_relay_handoff = match (
        context_relay_previous.as_ref().is_some_and(|previous| {
            eligible
                .iter()
                .any(|target| context_relay_target_changed(previous, target))
        }),
        context_relay_session_id.as_deref(),
        state.control_plane.as_ref(),
    ) {
        (true, Some(session_id), Some(control)) => {
            match control.context_relay_handoff(&model, session_id).await {
                Ok(handoff) => handoff,
                Err(_) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Context relay handoff state unavailable",
                    )
                }
            }
        }
        _ => None,
    };
    let attempts = if route.is_some_and(|route| route.strategy == RouteStrategy::Pipeline) {
        1
    } else if state.product_combo.is_some() {
        eligible.len()
    } else if product_access.is_some() {
        1 + state.product_fallbacks.len() - selected_product
    } else {
        route.map_or(1, |route| if route.fallback { eligible.len() } else { 1 })
    };
    let mut final_response = None;
    let mut last_retry_response = None;
    let mut final_translated = false;
    let mut final_antigravity_translated = false;
    let mut final_accounting = None;
    let mut final_served_model = None;
    let mut final_load_guard = None;
    let mut final_signature_context = None;
    let mut last_retry_load_guard = None;
    let mut saw_open_circuit = false;
    let mut closest_circuit_retry_ms: Option<u64> = None;
    let mut saw_availability_block = false;
    let mut closest_availability_retry_ms: Option<u64> = None;
    let mut availability_model_scope = true;
    let mut saw_terminal_availability = false;
    let mut saw_expired_credential = false;
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
        let target = if direct_alias {
            eligible.get(offset).copied()
        } else {
            attempt_order.map(|order| eligible[order[offset]])
        };
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
        let credential_expires_at_unix = target
            .map(|target| target.credential_expires_at_unix)
            .or_else(|| {
                live_provider
                    .as_ref()
                    .map(|provider| provider.credential_expires_at_unix)
            })
            .unwrap_or(0);
        if credential_expires_at_unix > 0 && unix_time_ms() / 1_000 >= credential_expires_at_unix {
            saw_expired_credential = true;
            if target.is_some() {
                continue;
            }
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Provider credential expired",
            );
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
        let accounting_attempt = if product_usage_accounting {
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
            Some(UsageAttempt::Product {
                connection: connection.clone(),
                model: target_model.to_owned(),
                prices,
                event_id,
            })
        } else if let Some(identity) = native_usage_identity.as_ref() {
            let Some(control) = state.control_plane.as_ref() else {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Native usage accounting unavailable",
                );
            };
            let provider = target
                .and_then(|target| target.provider_name.as_deref())
                .or_else(|| {
                    live_provider
                        .as_ref()
                        .and_then(|provider| provider.provider_name.as_deref())
                });
            let Some(provider) = provider else {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Native usage provider unavailable",
                );
            };
            let target_model = target.map_or(model.as_str(), |target| target.model.as_str());
            if protocol == ProviderProtocol::CohereRerank {
                let (event_id, price) = match control
                    .begin_native_rerank_usage(
                        identity,
                        provider,
                        target_model,
                        &native_usage_attribution,
                    )
                    .await
                {
                    Ok(attempt) => attempt,
                    Err("native usage quota exceeded") => {
                        return error(
                            StatusCode::TOO_MANY_REQUESTS,
                            "Client token or spend quota exceeded",
                        )
                    }
                    Err(_) => {
                        return error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "Native rerank usage reservation unavailable",
                        )
                    }
                };
                Some(UsageAttempt::NativeRerank {
                    control: control.clone(),
                    identity: identity.clone(),
                    attribution: native_usage_attribution.clone(),
                    provider: provider.to_owned(),
                    model: target_model.to_owned(),
                    price,
                    event_id,
                })
            } else {
                let (event_id, prices) = match control
                    .begin_native_usage(
                        identity,
                        provider,
                        target_model,
                        (requested_model != target_model).then_some(requested_model.as_str()),
                        &native_usage_attribution,
                    )
                    .await
                {
                    Ok(attempt) => attempt,
                    Err("native usage quota exceeded") => {
                        return error(
                            StatusCode::TOO_MANY_REQUESTS,
                            "Client token or spend quota exceeded",
                        )
                    }
                    Err(_) => {
                        return error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "Native usage reservation unavailable",
                        )
                    }
                };
                Some(UsageAttempt::Native {
                    control: control.clone(),
                    identity: identity.clone(),
                    attribution: native_usage_attribution.clone(),
                    provider: provider.to_owned(),
                    model: target_model.to_owned(),
                    prices,
                    event_id,
                })
            }
        } else {
            None
        };
        let translate_anthropic =
            target.is_some_and(|target| target.protocol == ProviderProtocol::OpenAiToAnthropic);
        let translate_antigravity =
            target.is_some_and(|target| target.protocol == ProviderProtocol::OpenAiToAntigravity);
        let attempt_signature_context = if translate_antigravity {
            match (
                state.control_plane.as_ref(),
                target.and_then(|target| target.provider_id.as_deref()),
            ) {
                (Some(control), Some(provider_id)) => {
                    Some(antigravity_translation::SignatureContext::new(
                        control.clone(),
                        provider_id.to_owned(),
                    ))
                }
                (Some(_), None) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Antigravity provider identity unavailable",
                    )
                }
                (None, _) => None,
            }
        } else {
            None
        };
        let attempt_signatures = if let Some(context) = attempt_signature_context.as_ref() {
            match context
                .control()
                .antigravity_thought_signatures(context.provider_id(), &antigravity_history_ids)
                .await
            {
                Ok(signatures) => Some(signatures),
                Err(_) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Antigravity thought signature storage unavailable",
                    )
                }
            }
        } else {
            translate_antigravity.then(HashMap::new)
        };
        let attempt_protocol = target.map_or(protocol, |target| target.protocol);
        let attempt_antigravity = matches!(
            attempt_protocol,
            ProviderProtocol::Antigravity | ProviderProtocol::OpenAiToAntigravity
        );
        let (client, url, provider_key, mut payload) = match target {
            Some(target) => {
                let mut attempt_parsed = parsed.clone();
                if let Some((_, previous_model)) = context_relay_previous
                    .as_ref()
                    .filter(|previous| context_relay_target_changed(previous, target))
                {
                    if inject_context_relay_handoff(
                        &mut attempt_parsed,
                        protocol,
                        previous_model,
                        &target.model,
                        context_relay_handoff.as_ref(),
                    )
                    .is_err()
                    {
                        return error(
                            StatusCode::BAD_REQUEST,
                            "Context relay is incompatible with this request body",
                        );
                    }
                }
                if attempt_protocol == ProviderProtocol::Antigravity {
                    if let Some(project) = target.antigravity_project.as_deref() {
                        attempt_parsed["project"] = serde_json::Value::String(project.to_owned());
                    }
                }
                let encoded = if translate_antigravity {
                    antigravity_translation::request(
                        &attempt_parsed,
                        &target.model,
                        target.antigravity_project.as_deref(),
                        attempt_signatures.as_ref(),
                    )
                    .and_then(|value| serde_json::to_vec(&value).map_err(|_| ()))
                } else if translate_anthropic {
                    translation::request(&attempt_parsed, &target.model)
                        .and_then(|value| serde_json::to_vec(&value).map_err(|_| ()))
                } else {
                    if protocol != ProviderProtocol::Gemini {
                        attempt_parsed["model"] = serde_json::Value::String(target.model.clone());
                    }
                    serde_json::to_vec(&attempt_parsed).map_err(|_| ())
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
                if protocol == ProviderProtocol::Antigravity {
                    if let Some(project) = live_provider
                        .as_ref()
                        .and_then(|provider| provider.antigravity_project.as_deref())
                    {
                        parsed["project"] = serde_json::Value::String(project.to_owned());
                    }
                }
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
        if attempt_antigravity {
            payload = match antigravity_credits_payload(
                &payload,
                state.antigravity_credits_mode == AntigravityCreditsMode::Always,
            ) {
                Ok(payload) => payload,
                Err(()) => {
                    return error(StatusCode::BAD_REQUEST, "Invalid Antigravity JSON request")
                }
            };
        }
        let claude_identity = target
            .and_then(|target| target.claude_identity.as_deref())
            .or_else(|| {
                live_provider
                    .as_ref()
                    .and_then(|provider| provider.claude_identity.as_deref())
            });
        let attempt_provider_name = target
            .and_then(|target| target.provider_name.as_deref())
            .or_else(|| {
                live_provider
                    .as_ref()
                    .and_then(|provider| provider.provider_name.as_deref())
            });
        let attempt_provider_id = target
            .and_then(|target| target.provider_id.as_deref())
            .or_else(|| {
                live_provider
                    .as_ref()
                    .and_then(|provider| provider.provider_id.as_deref())
            });
        if let Some(identity) = claude_identity {
            if !matches!(
                attempt_protocol,
                ProviderProtocol::Anthropic | ProviderProtocol::OpenAiToAnthropic
            ) {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Claude OAuth protocol is incompatible with this route",
                );
            }
            payload = match claude_cli_payload(&payload, identity) {
                Ok(payload) => payload,
                Err(()) => {
                    return error(
                        StatusCode::BAD_REQUEST,
                        "Claude OAuth requires a compatible Anthropic request body",
                    )
                }
            };
        }
        let claude_request_id = if claude_identity.is_some() {
            match request_uuid_v4() {
                Ok(value) => Some(value),
                Err(()) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Claude request identity unavailable",
                    )
                }
            }
        } else {
            None
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
        if attempt_antigravity {
            target_url.set_query(Some("alt=sse"));
        }
        let auth_scheme = target
            .map(|target| target.auth_scheme)
            .or_else(|| live_provider.as_ref().map(|provider| provider.auth_scheme))
            .unwrap_or_else(|| {
                ProviderAuthScheme::Auto
                    .resolve(attempt_protocol)
                    .expect("built-in authentication must resolve")
            });
        let antigravity_project = attempt_antigravity
            .then(|| {
                target
                    .and_then(|target| target.antigravity_project.as_deref())
                    .or_else(|| parsed.get("project").and_then(serde_json::Value::as_str))
                    .filter(|value| {
                        !value.is_empty()
                            && value.len() <= 256
                            && !value.chars().any(char::is_control)
                            && *value != "test-project"
                            && *value != "project-id"
                    })
                    .map(str::to_owned)
            })
            .flatten();
        // Keep the finite JSON upload replayable. Antigravity's official CLI
        // retries a project-scoped 403 once without x-goog-user-project because
        // consumer accounts can have a valid session but no permission to bill
        // the bootstrapped project.
        let build_upstream = |include_antigravity_project: bool, request_payload: &[u8]| {
            let mut upstream = client
                .post(target_url.clone())
                .header(header::CONTENT_TYPE, "application/json")
                .body(request_payload.to_vec());
            upstream = match auth_scheme {
                ProviderAuthScheme::Bearer => {
                    upstream.header(header::AUTHORIZATION, provider_key.clone())
                }
                ProviderAuthScheme::XApiKey => upstream.header("x-api-key", provider_key.clone()),
                ProviderAuthScheme::XGoogApiKey => {
                    upstream.header("x-goog-api-key", provider_key.clone())
                }
                ProviderAuthScheme::None => upstream,
                ProviderAuthScheme::Auto => unreachable!("authentication was resolved"),
            };
            upstream = github_copilot_headers(upstream, attempt_provider_name, attempt_provider_id);
            if claude_identity.is_none() {
                match &anthropic_headers {
                    Some((version, beta)) => {
                        upstream = upstream.header("anthropic-version", version.clone());
                        if let Some(beta) = beta {
                            upstream = upstream.header("anthropic-beta", beta.clone());
                        }
                    }
                    None if translate_anthropic => {
                        upstream = upstream.header("anthropic-version", "2023-06-01");
                    }
                    None => {}
                }
            }
            if let Some(identity) = claude_identity {
                let mut beta = anthropic_headers
                    .as_ref()
                    .and_then(|(_, beta)| beta.as_ref())
                    .and_then(|beta| beta.to_str().ok())
                    .unwrap_or("")
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                if !beta.iter().any(|value| value == CLAUDE_OAUTH_BETA) {
                    beta.push(CLAUDE_OAUTH_BETA.to_owned());
                }
                upstream = upstream
                    .header("anthropic-version", "2023-06-01")
                    .header("anthropic-beta", beta.join(","))
                    .header("anthropic-dangerous-direct-browser-access", "true")
                    .header("x-app", "cli")
                    .header(header::USER_AGENT, CLAUDE_CLI_USER_AGENT)
                    .header("x-stainless-timeout", "600")
                    .header("x-claude-code-session-id", identity.session_id.as_ref());
                if let Some(request_id) = claude_request_id.as_deref() {
                    upstream = upstream.header("x-client-request-id", request_id);
                }
            }
            if attempt_antigravity {
                upstream = upstream
                    .header(header::ACCEPT, "text/event-stream")
                    .header(header::USER_AGENT, ANTIGRAVITY_CLI_USER_AGENT);
                if include_antigravity_project {
                    if let Some(project) = antigravity_project.as_deref() {
                        upstream = upstream.header("x-goog-user-project", project);
                    }
                }
            } else if let Some(accept) = &accept {
                upstream = upstream.header(header::ACCEPT, accept.clone());
            }
            if let Some(headers) = target
                .map(|t| &t.custom_headers)
                .or_else(|| live_provider.as_ref().map(|p| &p.custom_headers))
            {
                upstream = upstream.headers(headers.clone());
            }
            upstream
        };
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
        let mut include_antigravity_project = true;
        let response = match tokio::time::timeout(
            HEADER_TIMEOUT,
            build_upstream(include_antigravity_project, &payload).send(),
        )
        .await
        {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err(false),
            Err(_) => Err(true),
        };
        let response = match response {
            Ok(response)
                if response.status() == StatusCode::FORBIDDEN && antigravity_project.is_some() =>
            {
                include_antigravity_project = false;
                match tokio::time::timeout(
                    HEADER_TIMEOUT,
                    build_upstream(include_antigravity_project, &payload).send(),
                )
                .await
                {
                    Ok(Ok(response)) => Ok(response),
                    Ok(Err(_)) => Err(false),
                    Err(_) => Err(true),
                }
            }
            response => response,
        };
        let response = match response {
            Ok(response) => response,
            Err(false) => {
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
            Err(true) => {
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
        let mut response = inspect_provider_response(response).await;
        let credits_retry = attempt_antigravity
            && state.antigravity_credits_mode == AntigravityCreditsMode::Retry
            && response.status() == StatusCode::TOO_MANY_REQUESTS
            && resilience::antigravity_credits_retry_eligible(response.error_body());
        if credits_retry {
            let credits_payload = match antigravity_credits_payload(&payload, true) {
                Ok(payload) => payload,
                Err(()) => {
                    return error(StatusCode::BAD_REQUEST, "Invalid Antigravity JSON request")
                }
            };
            if let Ok(Ok(credits_response)) = tokio::time::timeout(
                ANTIGRAVITY_CREDITS_RETRY_TIMEOUT,
                build_upstream(include_antigravity_project, &credits_payload).send(),
            )
            .await
            {
                response = inspect_provider_response(credits_response).await;
            }
        }
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
        let failure_class = resilience::classify_provider_failure(
            rate_limit_scope,
            provider_name,
            response.status(),
            response.headers(),
            response.error_body(),
        );
        if let (Some(availability), Some(permit)) = (availability, availability_permit) {
            let recorded = match failure_class {
                resilience::ProviderFailureClass::Banned => {
                    availability
                        .record_terminal_failure(permit, availability::TerminalStatus::Banned)
                        .await
                }
                resilience::ProviderFailureClass::Expired => {
                    availability
                        .record_terminal_failure(permit, availability::TerminalStatus::Expired)
                        .await
                }
                resilience::ProviderFailureClass::AmbiguousExpired => {
                    availability
                        .record_ambiguous_auth_failure(
                            permit,
                            response.status(),
                            retry_after_hint_ms(response.headers()),
                        )
                        .await
                }
                resilience::ProviderFailureClass::CreditsExhausted => {
                    availability
                        .record_terminal_failure(
                            permit,
                            availability::TerminalStatus::CreditsExhausted,
                        )
                        .await
                }
                resilience::ProviderFailureClass::Model => {
                    availability
                        .record_model_failure(
                            permit,
                            target_model,
                            response.status(),
                            retry_after_hint_ms(response.headers()),
                        )
                        .await
                }
                resilience::ProviderFailureClass::Transient
                    if availability::connection_failure_status(response.status()) =>
                {
                    availability
                        .record_connection_failure(
                            permit,
                            response.status(),
                            retry_after_hint_ms(response.headers()),
                        )
                        .await
                }
                resilience::ProviderFailureClass::Transient
                    if availability::model_failure_status(response.status()) =>
                {
                    availability
                        .record_model_failure(
                            permit,
                            target_model,
                            response.status(),
                            retry_after_hint_ms(response.headers()),
                        )
                        .await
                }
                resilience::ProviderFailureClass::Transient if response.status().is_success() => {
                    availability.record_success(permit, target_model).await
                }
                resilience::ProviderFailureClass::Transient => Ok(()),
            };
            if recorded.is_err() {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Provider availability accounting unavailable",
                );
            }
        }
        let retryable = failure_class.semantic_fallback()
            || response.status() == StatusCode::TOO_MANY_REQUESTS
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
                if route.is_some_and(|route| route.strategy == RouteStrategy::ContextRelay) {
                    if let (Some(control), Some(session_id)) = (
                        state.control_plane.as_ref(),
                        context_relay_session_id.as_deref(),
                    ) {
                        if control
                            .record_context_relay_session(&model, session_id, target)
                            .await
                            .is_err()
                        {
                            eprintln!("context relay session persistence unavailable");
                        }
                        if let Some(route) =
                            route.filter(|route| route.strategy == RouteStrategy::ContextRelay)
                        {
                            let switched_source = context_relay_previous
                                .as_ref()
                                .filter(|previous| context_relay_target_changed(previous, target))
                                .map(|(_, previous_model)| previous_model.clone());
                            let now_unix_ms = unix_time_ms();
                            let quota_expiry = context_relay_quota_expiry(
                                target,
                                route.context_relay.handoff_threshold,
                                now_unix_ms,
                            );
                            let generation = switched_source
                                .map(|source_model| {
                                    (
                                        source_model,
                                        now_unix_ms.saturating_add(CONTEXT_RELAY_SUMMARY_TTL_MS),
                                        true,
                                    )
                                })
                                .or_else(|| {
                                    quota_expiry
                                        .map(|expires_at| (target.model.clone(), expires_at, false))
                                });
                            if context_relay_handoff.is_none() {
                                if let (
                                    Some((source_model, expires_at, handoff_known_absent)),
                                    Some(summary_target),
                                    Some((history, message_count)),
                                ) = (
                                    generation,
                                    context_relay_summary_target(route, &eligible, target),
                                    context_relay_history(
                                        &parsed,
                                        route.context_relay.max_messages_for_summary as usize,
                                        route.context_relay.relay_mode == "schema-locked",
                                    ),
                                ) {
                                    spawn_context_relay_summary(
                                        control.clone(),
                                        model.clone(),
                                        session_id.to_owned(),
                                        summary_target,
                                        history,
                                        source_model,
                                        message_count,
                                        expires_at,
                                        handoff_known_absent,
                                    );
                                }
                            }
                        }
                    }
                }
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
        final_antigravity_translated = translate_antigravity;
        final_accounting = accounting_attempt;
        final_served_model = response
            .status()
            .is_success()
            .then(|| served_model_header(provider_name, target_model))
            .flatten();
        final_response = Some(response);
        final_load_guard = load_guard;
        final_signature_context = attempt_signature_context;
        break;
    }
    let (response, provider_load_guard) = if let Some(response) = final_response {
        (response, final_load_guard)
    } else if let Some(response) = last_retry_response {
        (response, last_retry_load_guard)
    } else {
        if saw_expired_credential {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Provider credentials expired",
            );
        }
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
    let response_alias = route.and_then(|route| route.public_model_alias.as_deref());
    if final_antigravity_translated && response.status().is_success() {
        let signature_context = final_signature_context;
        let Some(response) = response.into_streaming() else {
            return error(StatusCode::BAD_GATEWAY, "Invalid provider response");
        };
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
                "Invalid Antigravity stream content type",
            );
        }
        if parsed.get("stream").and_then(serde_json::Value::as_bool) == Some(true) {
            let include_usage = parsed
                .pointer("/stream_options/include_usage")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let body = if let Some(accounting) = final_accounting {
                let context = match accounting.into_context(product_access.as_ref()) {
                    Ok(context) => context,
                    Err(_) => {
                        return error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "Usage accounting unavailable",
                        )
                    }
                };
                antigravity_translation::forward_accounted(
                    response,
                    model.clone(),
                    include_usage,
                    context,
                    (permit, client_permit),
                    provider_load_guard,
                    signature_context,
                )
            } else {
                let stream = antigravity_translation::translate(
                    response,
                    model.clone(),
                    include_usage,
                    signature_context,
                )
                .map(move |chunk| {
                    let _keep_alive = (&permit, &client_permit, &provider_load_guard);
                    chunk
                });
                Body::from_stream(stream)
            };
            let mut result = Response::new(body);
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
            attach_served_model(&mut result, final_served_model.as_ref());
            return model_alias_response::rewrite(result, response_alias).await;
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
            let response = antigravity_translation::response(&bytes, &model)?;
            response.persist(signature_context.as_ref()).await
        };
        let value = match tokio::time::timeout(HEADER_TIMEOUT, read).await {
            Ok(Ok(value)) => value,
            _ => return error(StatusCode::BAD_GATEWAY, "Invalid Antigravity response"),
        };
        if let Some(accounting) = final_accounting {
            let usage = match accounting::ChatUsage::from_response(&value) {
                Ok(usage) => usage,
                Err(_) => {
                    return error(
                        StatusCode::BAD_GATEWAY,
                        "Provider response is missing valid token usage",
                    )
                }
            };
            if accounting
                .record(product_access.as_ref(), &usage)
                .await
                .is_err()
            {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Usage accounting unavailable",
                );
            }
        }
        let mut result = (StatusCode::OK, Json(value)).into_response();
        attach_served_model(&mut result, final_served_model.as_ref());
        return model_alias_response::rewrite(result, response_alias).await;
    }
    if final_translated && response.status().is_success() {
        let Some(response) = response.into_streaming() else {
            return error(StatusCode::BAD_GATEWAY, "Invalid provider response");
        };
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
            let mut result = (
                [
                    (header::CONTENT_TYPE, "text/event-stream"),
                    (header::CACHE_CONTROL, "no-cache"),
                    (header::HeaderName::from_static("x-accel-buffering"), "no"),
                ],
                Body::from_stream(stream),
            )
                .into_response();
            attach_served_model(&mut result, final_served_model.as_ref());
            return model_alias_response::rewrite(result, response_alias).await;
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
            Ok(Ok(value)) => {
                let mut result = (StatusCode::OK, Json(value)).into_response();
                attach_served_model(&mut result, final_served_model.as_ref());
                model_alias_response::rewrite(result, response_alias).await
            }
            _ => error(StatusCode::BAD_GATEWAY, "Invalid Anthropic response"),
        };
    }
    if response.status().is_success() {
        if let Some(accounting_attempt) = final_accounting {
            let status = response.status();
            let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
            let Some(response) = response.into_streaming() else {
                return error(StatusCode::BAD_GATEWAY, "Invalid provider response");
            };
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
                let usage_context = match accounting_attempt {
                    UsageAttempt::Product {
                        connection,
                        model,
                        prices,
                        event_id,
                    } => {
                        let Some(access) = &product_access else {
                            return error(
                                StatusCode::SERVICE_UNAVAILABLE,
                                "Usage accounting unavailable",
                            );
                        };
                        usage_stream::UsageContext::Product {
                            connection,
                            event_id,
                            key: access.key_id.clone(),
                            model,
                            prices,
                            usage_attributes: access.usage_attributes.clone(),
                        }
                    }
                    UsageAttempt::Native {
                        control,
                        identity,
                        attribution,
                        provider,
                        model,
                        prices,
                        event_id,
                    } => usage_stream::UsageContext::Native {
                        control,
                        identity,
                        attribution,
                        provider,
                        model,
                        prices,
                        event_id,
                    },
                    UsageAttempt::NativeRerank { .. } => {
                        return error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "Rerank usage cannot be streamed",
                        )
                    }
                };
                let body = usage_stream::forward(
                    response,
                    protocol,
                    usage_context,
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
                attach_served_model(&mut result, final_served_model.as_ref());
                return model_alias_response::rewrite(result, response_alias).await;
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
            let recorded = match accounting_attempt {
                UsageAttempt::NativeRerank {
                    control,
                    identity,
                    attribution,
                    provider,
                    model,
                    price,
                    event_id,
                } => {
                    let value = match serde_json::from_slice::<serde_json::Value>(&bytes) {
                        Ok(value) => value,
                        Err(_) => return error(StatusCode::BAD_GATEWAY, "Invalid rerank response"),
                    };
                    let search_units = match value.pointer("/meta/billed_units/search_units") {
                        Some(value) => match value.as_u64() {
                            Some(units) => units,
                            None => {
                                return error(
                                    StatusCode::BAD_GATEWAY,
                                    "Provider response contains invalid rerank usage",
                                )
                            }
                        },
                        None if price.is_some() => {
                            return error(
                                StatusCode::BAD_GATEWAY,
                                "Priced rerank response is missing billed search units",
                            )
                        }
                        None => 0,
                    };
                    control
                        .record_native_rerank_usage(
                            &event_id,
                            &identity,
                            control_plane::NativeRerankUsageRecord {
                                provider: &provider,
                                model: &model,
                                search_units,
                                price: price.as_ref(),
                                attribution: &attribution,
                            },
                        )
                        .await
                }
                token_attempt @ (UsageAttempt::Product { .. } | UsageAttempt::Native { .. }) => {
                    let usage = serde_json::from_slice::<serde_json::Value>(&bytes)
                        .ok()
                        .and_then(|v| {
                            if v.get("service_tier").is_some_and(|tier| {
                                !tier.is_null() && tier.as_str() != Some("default")
                            }) {
                                return None;
                            }
                            match protocol {
                                ProviderProtocol::OpenAiEmbeddings => {
                                    accounting::ChatUsage::from_embedding_response(&v).ok()
                                }
                                ProviderProtocol::OpenAiResponses => {
                                    accounting::ChatUsage::from_responses_response(&v).ok()
                                }
                                ProviderProtocol::Anthropic => {
                                    accounting::ChatUsage::from_anthropic_response(&v).ok()
                                }
                                ProviderProtocol::Gemini => {
                                    accounting::ChatUsage::from_gemini_response(&v).ok()
                                }
                                ProviderProtocol::Antigravity => {
                                    accounting::ChatUsage::from_gemini_response(
                                        v.get("response").unwrap_or(&v),
                                    )
                                    .ok()
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
                    token_attempt.record(product_access.as_ref(), &usage).await
                }
            };
            if recorded.is_err() {
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
            attach_served_model(&mut result, final_served_model.as_ref());
            return model_alias_response::rewrite(result, response_alias).await;
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
    let Some(stream) = response.into_body_stream() else {
        return error(StatusCode::BAD_GATEWAY, "Invalid provider error response");
    };
    let stream = stream.map(move |chunk| {
        let _keep_alive = (&permit, &client_permit, &provider_load_guard);
        chunk
    });
    let mut result = Response::new(Body::from_stream(stream));
    *result.status_mut() = status;
    *result.headers_mut() = headers;
    attach_served_model(&mut result, final_served_model.as_ref());
    model_alias_response::rewrite(result, response_alias).await
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
    fn usage_attribution_prefers_body_user_and_normalizes_tags() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-red-router-end-user",
            HeaderValue::from_static("header-user"),
        );
        headers.insert(
            "x-red-router-tags",
            HeaderValue::from_static("Team-A, production"),
        );
        let body = serde_json::json!({
            "user": "body-user",
            "metadata": {"tags": ["TEAM-A", " analytics "]}
        });
        let attribution = usage_attribution(&headers, &body).unwrap();
        assert_eq!(attribution.end_user.as_deref(), Some("body-user"));
        assert_eq!(attribution.tags, vec!["team-a", "analytics", "production"]);
    }

    #[test]
    fn context_relay_rejects_ambiguous_or_unsafe_session_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("x-session-id", HeaderValue::from_static("session-one"));
        assert_eq!(
            parse_context_relay_session_id(&headers).unwrap().as_deref(),
            Some("session-one")
        );
        headers.insert(
            "x-omniroute-session-id",
            HeaderValue::from_static("session-two"),
        );
        assert!(parse_context_relay_session_id(&headers).is_err());

        let mut oversized = HeaderMap::new();
        oversized.insert(
            "x-session-id",
            HeaderValue::from_str(&"x".repeat(257)).unwrap(),
        );
        assert!(parse_context_relay_session_id(&oversized).is_err());
    }

    #[test]
    fn context_relay_uses_each_protocols_native_system_channel() {
        let mut responses = serde_json::json!({"input":"hello","instructions":"existing"});
        inject_context_relay_handoff(
            &mut responses,
            ProviderProtocol::OpenAiResponses,
            "old<&",
            "new",
            None,
        )
        .unwrap();
        let instructions = responses["instructions"].as_str().unwrap();
        assert!(instructions.contains("<previous_model>old&lt;&amp;</previous_model>"));
        assert!(instructions.ends_with("existing"));

        let mut anthropic = serde_json::json!({
            "system":"existing",
            "messages":[{"role":"user","content":"hello"}]
        });
        inject_context_relay_handoff(
            &mut anthropic,
            ProviderProtocol::Anthropic,
            "old",
            "new",
            None,
        )
        .unwrap();
        assert_eq!(anthropic["system"][0]["text"], "existing");
        assert!(anthropic["system"][1]["text"]
            .as_str()
            .unwrap()
            .contains("<current_model>new</current_model>"));
        assert_eq!(anthropic["messages"][0]["content"], "hello");

        let mut gemini = serde_json::json!({"contents":[]});
        inject_context_relay_handoff(&mut gemini, ProviderProtocol::Gemini, "old", "new", None)
            .unwrap();
        assert!(gemini["systemInstruction"]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("<context_handoff>"));

        let mut chat = serde_json::json!({"messages":[{"role":"user","content":"next"}]});
        let handoff = control_plane::ContextRelayHandoff {
            summary: "Migrating <Next> to Rust".to_owned(),
            key_decisions: vec!["Rust owns persistence".to_owned()],
            task_progress: "Relay storage is ready".to_owned(),
            active_entities: vec!["red-routerd".to_owned()],
            message_count: 7,
            source_model: "old".to_owned(),
        };
        inject_context_relay_handoff(
            &mut chat,
            ProviderProtocol::OpenAi,
            "old",
            "new",
            Some(&handoff),
        )
        .unwrap();
        let content = chat["messages"][0]["content"].as_str().unwrap();
        assert!(content.contains("<session_summary>Migrating &lt;Next&gt; to Rust"));
        assert!(content.contains("<messages_processed>7</messages_processed>"));
        assert_eq!(chat["messages"][1]["content"], "next");
    }

    #[test]
    fn context_relay_accepts_only_structured_provider_summaries() {
        let response = serde_json::json!({
            "choices":[{"message":{"content":"```json\n{\"summary\":\"Continue the Rust port.\",\"keyDecisions\":[\"SQLite remains the default\"],\"taskProgress\":\"Persistence is migrated.\",\"activeEntities\":[\"red-routerd\"]}\n```"}}]
        });
        let parsed = parse_context_relay_summary(&response, "source-model", 4).unwrap();
        assert_eq!(parsed.summary, "Continue the Rust port.");
        assert_eq!(parsed.key_decisions, ["SQLite remains the default"]);
        assert_eq!(parsed.message_count, 4);
        assert!(parse_context_relay_summary(
            &serde_json::json!({"choices":[{"message":{"content":"invented prose"}}]}),
            "source-model",
            4,
        )
        .is_none());
    }

    #[test]
    fn fusion_preserves_native_message_shapes_and_tool_bypass_semantics() {
        let prompt = fusion_judge_prompt(&[
            FusionPanelAnswer {
                target_index: 0,
                text: "first answer".to_owned(),
            },
            FusionPanelAnswer {
                target_index: 1,
                text: "second answer".to_owned(),
            },
        ]);
        assert!(prompt.contains("[Source 1]\nfirst answer"));
        assert!(prompt.contains("[Source 2]\nsecond answer"));

        let gemini = fusion_append_judge_prompt(
            &serde_json::json!({
                "contents":[{"role":"user","parts":[{"text":"question"}]}]
            }),
            prompt.clone(),
        )
        .unwrap();
        assert_eq!(gemini["contents"][0]["parts"][0]["text"], "question");
        assert_eq!(gemini["contents"][1]["role"], "user");
        assert_eq!(gemini["contents"][1]["parts"][0]["text"], prompt);

        let responses = fusion_append_judge_prompt(
            &serde_json::json!({"input":"question"}),
            "judge".to_owned(),
        )
        .unwrap();
        assert_eq!(responses["input"][0]["content"], "question");
        assert_eq!(responses["input"][1]["content"], "judge");

        assert!(fusion_request_has_tools(&serde_json::json!({
            "tools":[{"type":"function"}],
            "tool_choice":"auto"
        })));
        assert!(!fusion_request_has_tools(&serde_json::json!({
            "tools":[{"type":"function"}],
            "tool_choice":"none"
        })));
    }

    #[test]
    fn pipeline_threads_protocol_native_bodies_and_preserves_final_contract() {
        let chat = serde_json::json!({
            "messages":[{"role":"user","content":"original"}],
            "stream":true,
            "tools":[{"type":"function"}]
        });
        let first =
            pipeline_prepend_system_instruction(&chat, Some("draft"), ProviderProtocol::OpenAi)
                .unwrap();
        assert_eq!(first["messages"][0]["role"], "system");
        assert_eq!(first["messages"][1]["content"], "original");
        let final_chat =
            pipeline_transform_body(&chat, Some("polish"), "drafted", ProviderProtocol::OpenAi)
                .unwrap();
        assert_eq!(final_chat["messages"][0]["content"], "polish");
        assert_eq!(final_chat["messages"][1]["content"], "drafted");
        assert_eq!(final_chat["stream"], true);
        assert_eq!(final_chat["tools"][0]["type"], "function");

        let responses = pipeline_prepend_system_instruction(
            &serde_json::json!({"input":"original","stream":true}),
            Some("draft"),
            ProviderProtocol::OpenAiResponses,
        )
        .unwrap();
        assert_eq!(responses["input"][0]["role"], "system");
        assert_eq!(responses["input"][1]["content"], "original");
        let responses = pipeline_transform_body(
            &responses,
            Some("polish"),
            "drafted",
            ProviderProtocol::OpenAiResponses,
        )
        .unwrap();
        assert_eq!(responses["input"][0]["content"], "polish");
        assert_eq!(responses["input"][1]["content"], "drafted");

        let gemini = pipeline_transform_body(
            &serde_json::json!({
                "contents":[{"role":"user","parts":[{"text":"original"}]}]
            }),
            Some("polish"),
            "drafted",
            ProviderProtocol::Gemini,
        )
        .unwrap();
        assert_eq!(
            gemini["contents"][0]["parts"][0]["text"],
            "polish\n\ndrafted"
        );

        let anthropic = pipeline_prepend_system_instruction(
            &serde_json::json!({
                "system":"existing",
                "messages":[{"role":"user","content":"original"}]
            }),
            Some("draft"),
            ProviderProtocol::Anthropic,
        )
        .unwrap();
        assert_eq!(anthropic["system"], "draft\n\nexisting");
        assert_eq!(anthropic["messages"][0]["role"], "user");
        let anthropic = pipeline_transform_body(
            &anthropic,
            Some("polish"),
            "drafted",
            ProviderProtocol::Anthropic,
        )
        .unwrap();
        assert_eq!(anthropic["system"], "polish");
        assert_eq!(anthropic["messages"][0]["content"], "drafted");

        assert_eq!(pipeline_attempt_order(2, 3)[..3], [2, 0, 1]);
    }

    #[tokio::test]
    async fn context_relay_generates_native_gemini_and_antigravity_summaries() {
        let gemini_bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed_gemini = gemini_bodies.clone();
        let antigravity_bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed_antigravity = antigravity_bodies.clone();
        let antigravity_requests = Arc::new(AtomicUsize::new(0));
        let observed_antigravity_requests = antigravity_requests.clone();
        let app = Router::new()
            .route(
                "/v1beta/models/gemini-2.5-flash:generateContent",
                post(
                    move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                        let observed = observed_gemini.clone();
                        async move {
                            assert_eq!(
                                headers["x-goog-api-key"].to_str().unwrap(),
                                "gemini-secret"
                            );
                            observed.lock().unwrap().push(body);
                            Json(serde_json::json!({
                                "candidates":[{"content":{"role":"model","parts":[{"text":serde_json::json!({
                                    "summary":"Gemini generated the relay summary.",
                                    "keyDecisions":["Use the native Gemini endpoint"],
                                    "taskProgress":"Gemini generation is covered.",
                                    "activeEntities":["gemini-2.5-flash"]
                                }).to_string()}]}}],
                                "usageMetadata":{
                                    "promptTokenCount":7,
                                    "candidatesTokenCount":3,
                                    "totalTokenCount":10
                                }
                            }))
                        }
                    },
                ),
            )
            .route(
                "/v1internal:streamGenerateContent",
                post(
                    move |uri: Uri,
                          headers: HeaderMap,
                          Json(body): Json<serde_json::Value>| {
                        let observed = observed_antigravity.clone();
                        let requests = observed_antigravity_requests.clone();
                        async move {
                            let attempt = requests.fetch_add(1, Ordering::SeqCst);
                            assert_eq!(uri.query(), Some("alt=sse"));
                            assert_eq!(
                                headers[header::AUTHORIZATION].to_str().unwrap(),
                                "Bearer agy-secret"
                            );
                            assert_eq!(
                                headers[header::ACCEPT].to_str().unwrap(),
                                "text/event-stream"
                            );
                            assert_eq!(
                                headers[header::USER_AGENT].to_str().unwrap(),
                                ANTIGRAVITY_CLI_USER_AGENT
                            );
                            observed.lock().unwrap().push(body);
                            if attempt == 0 {
                                assert_eq!(
                                    headers["x-goog-user-project"].to_str().unwrap(),
                                    "relay-project"
                                );
                                return Response::builder()
                                    .status(StatusCode::FORBIDDEN)
                                    .body(Body::empty())
                                    .unwrap();
                            }
                            assert!(headers.get("x-goog-user-project").is_none());
                            let summary = serde_json::json!({
                                "summary":"Antigravity generated the relay summary.",
                                "keyDecisions":["Use the official CLI envelope"],
                                "taskProgress":"Antigravity SSE decoding is covered.",
                                "activeEntities":["antigravity"]
                            })
                            .to_string();
                            let event = serde_json::json!({"response":{
                                "responseId":"relay-summary",
                                "candidates":[{
                                    "content":{"role":"model","parts":[{"text":summary}]},
                                    "finishReason":"STOP"
                                }],
                                "usageMetadata":{
                                    "promptTokenCount":5,
                                    "candidatesTokenCount":5,
                                    "totalTokenCount":10
                                }
                            }});
                            Response::builder()
                                .status(StatusCode::OK)
                                .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
                                .body(Body::from(format!("data: {event}\n\n")))
                                .unwrap()
                        }
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();

        let gemini_target = ContextRelaySummaryTarget {
            client: client.clone(),
            upstream: reqwest::Url::parse(&format!("http://{address}/v1beta/models")).unwrap(),
            provider_key: HeaderValue::from_static("gemini-secret"),
            custom_headers: HeaderMap::new(),
            protocol: ProviderProtocol::Gemini,
            auth_scheme: ProviderAuthScheme::XGoogApiKey,
            tenant_id: Arc::from("red"),
            provider_name: "google".to_owned(),
            model: "gemini-2.5-flash".to_owned(),
            antigravity_project: None,
            claude_identity: None,
            rate_limit_scope: resilience::RateLimitScope::Auto,
            circuit: None,
            availability: None,
            in_flight: Arc::new(AtomicUsize::new(0)),
        };
        let ContextRelaySummaryOutcome::Generated(gemini) = generate_context_relay_summary(
            &gemini_target,
            "USER: continue the Rust migration".to_owned(),
            "gemini-source".to_owned(),
            3,
        )
        .await
        else {
            panic!("Gemini context relay summary was not generated");
        };
        assert_eq!(
            gemini.handoff.summary,
            "Gemini generated the relay summary."
        );
        assert_eq!(gemini.summary_model, "gemini-2.5-flash");
        assert_eq!((gemini.usage.input, gemini.usage.output), (7, 3));
        let gemini_body = gemini_bodies.lock().unwrap()[0].clone();
        assert_eq!(
            gemini_body["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert!(gemini_body["contents"][0]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("CONVERSATION HISTORY"));

        let antigravity_target = ContextRelaySummaryTarget {
            client,
            upstream: reqwest::Url::parse(&format!(
                "http://{address}/v1internal:streamGenerateContent"
            ))
            .unwrap(),
            provider_key: HeaderValue::from_static("Bearer agy-secret"),
            custom_headers: HeaderMap::new(),
            protocol: ProviderProtocol::Antigravity,
            auth_scheme: ProviderAuthScheme::Bearer,
            tenant_id: Arc::from("red"),
            provider_name: "agy".to_owned(),
            model: "gemini-2.5-pro".to_owned(),
            antigravity_project: Some(Arc::from("relay-project")),
            claude_identity: None,
            rate_limit_scope: resilience::RateLimitScope::Auto,
            circuit: None,
            availability: None,
            in_flight: Arc::new(AtomicUsize::new(0)),
        };
        let ContextRelaySummaryOutcome::Generated(antigravity) = generate_context_relay_summary(
            &antigravity_target,
            "USER: preserve the agent context".to_owned(),
            "antigravity-source".to_owned(),
            4,
        )
        .await
        else {
            panic!("Antigravity context relay summary was not generated");
        };
        assert_eq!(
            antigravity.handoff.summary,
            "Antigravity generated the relay summary."
        );
        assert_eq!(antigravity.summary_model, "gemini-2.5-pro");
        assert_eq!((antigravity.usage.input, antigravity.usage.output), (5, 5));
        assert_eq!(antigravity_requests.load(Ordering::SeqCst), 2);
        let antigravity_body = antigravity_bodies.lock().unwrap()[1].clone();
        assert_eq!(antigravity_body["project"], "relay-project");
        assert_eq!(antigravity_body["model"], "gemini-2.5-pro");
        assert_eq!(
            antigravity_body["request"]["generationConfig"]["maxOutputTokens"],
            800
        );
        assert!(
            antigravity_body["request"]["contents"][0]["parts"][0]["text"]
                .as_str()
                .unwrap()
                .contains("CONVERSATION HISTORY")
        );
        server.abort();
    }

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
    fn antigravity_credit_fields_are_owned_by_the_operator_policy() {
        let supplied = br#"{"model":"m","enabledCreditTypes":["CLIENT_VALUE"]}"#;
        let off: serde_json::Value =
            serde_json::from_slice(&antigravity_credits_payload(supplied, false).unwrap()).unwrap();
        assert!(off.get("enabledCreditTypes").is_none());
        let always: serde_json::Value =
            serde_json::from_slice(&antigravity_credits_payload(supplied, true).unwrap()).unwrap();
        assert_eq!(
            always["enabledCreditTypes"],
            serde_json::json!(["GOOGLE_ONE_AI"])
        );
    }

    #[test]
    fn claude_oauth_payload_preserves_one_cli_identity_prefix() {
        let identity = ClaudeIdentity {
            device_id: Arc::from(
                "abababababababababababababababababababababababababababababababab",
            ),
            account_uuid: Arc::from("123e4567-e89b-42d3-a456-426614174000"),
            session_id: Arc::from("123e4567-e89b-42d3-a456-426614174001"),
        };
        let first = claude_cli_payload(
            br#"{"model":"claude-sonnet","system":"operator prompt","messages":[]}"#,
            &identity,
        )
        .unwrap();
        let second = claude_cli_payload(&first, &identity).unwrap();
        let body: serde_json::Value = serde_json::from_slice(&second).unwrap();
        let system = body["system"].as_array().unwrap();
        assert_eq!(system.len(), 3);
        assert!(system[0]["text"]
            .as_str()
            .unwrap()
            .starts_with("x-anthropic-billing-header:"));
        assert_eq!(system[1]["text"], CLAUDE_SENTINEL);
        assert_eq!(system[2]["text"], "operator prompt");
        let user_id: serde_json::Value =
            serde_json::from_str(body["metadata"]["user_id"].as_str().unwrap()).unwrap();
        assert_eq!(user_id["device_id"], identity.device_id.as_ref());
        assert_eq!(user_id["account_uuid"], identity.account_uuid.as_ref());
        assert_eq!(user_id["session_id"], identity.session_id.as_ref());
    }

    #[test]
    fn model_quota_overrides_provider_quota_without_locking_the_hot_path() {
        let provider_quota = Arc::new(TargetQuota::default());
        provider_quota.update(&storage::StoredProviderQuota {
            provider_id: "agy".into(),
            session_remaining_ppm: 900_000,
            session_reset_unix_ms: 0,
            weekly_remaining_ppm: 800_000,
            weekly_reset_unix_ms: 0,
            limit_reached: false,
            observed_at_unix_ms: 1,
            expires_at_unix_ms: i64::MAX,
            revision: 1,
        });
        let model_quota = Arc::new(TargetQuota::default());
        model_quota.update_model(&storage::StoredProviderModelQuota {
            provider_id: "agy".into(),
            model_id: "gemini-3.1-pro".into(),
            session_remaining_ppm: 0,
            session_reset_unix_ms: 0,
            weekly_remaining_ppm: 600_000,
            weekly_reset_unix_ms: 0,
            limit_reached: true,
            observed_at_unix_ms: 1,
            expires_at_unix_ms: i64::MAX,
            revision: 2,
        });
        let target = ModelTarget {
            client: reqwest::Client::new(),
            upstream: reqwest::Url::parse("https://example.com/v1/chat/completions").unwrap(),
            provider_key: HeaderValue::from_static("secret"),
            custom_headers: HeaderMap::new(),
            model: "gemini-3.1-pro".into(),
            protocol: ProviderProtocol::OpenAi,
            auth_scheme: ProviderAuthScheme::Bearer,
            credential_expires_at_unix: 0,
            product_connection: None,
            product_model: None,
            provider_id: Some(Arc::from("agy")),
            provider_name: Some(Arc::from("antigravity")),
            antigravity_project: None,
            claude_identity: None,
            rate_limit_scope: resilience::RateLimitScope::Model,
            weight: 1,
            input_cost_per_million: None,
            output_cost_per_million: None,
            context_window_tokens: None,
            prompt: None,
            quota: Some(provider_quota.clone()),
            model_quota: Some(model_quota.clone()),
            circuit: None,
            availability: None,
            in_flight: Arc::new(AtomicUsize::new(0)),
        };
        assert!(target_quota(&target, 2).unwrap().limit_reached);
        assert!(!quota_preflight_allows(&target, 2, 20_000));
        model_quota.clear();
        assert_eq!(
            target_quota(&target, 2).unwrap().session_remaining_ppm,
            900_000
        );
        assert_eq!(context_relay_quota_expiry(&target, 0.8, 2), None);
        provider_quota.update(&storage::StoredProviderQuota {
            provider_id: "agy".into(),
            session_remaining_ppm: 150_000,
            session_reset_unix_ms: 10_000,
            weekly_remaining_ppm: 600_000,
            weekly_reset_unix_ms: 20_000,
            limit_reached: false,
            observed_at_unix_ms: 2,
            expires_at_unix_ms: i64::MAX,
            revision: 3,
        });
        assert_eq!(context_relay_quota_expiry(&target, 0.8, 2), Some(10_000));
        provider_quota.update(&storage::StoredProviderQuota {
            provider_id: "agy".into(),
            session_remaining_ppm: 40_000,
            session_reset_unix_ms: 10_000,
            weekly_remaining_ppm: 600_000,
            weekly_reset_unix_ms: 20_000,
            limit_reached: false,
            observed_at_unix_ms: 3,
            expires_at_unix_ms: i64::MAX,
            revision: 4,
        });
        assert_eq!(context_relay_quota_expiry(&target, 0.8, 2), None);
        assert!(quota_preflight_allows(&target, 2, 20_000));
        assert!(!quota_preflight_allows(&target, 2, 40_000));
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
