//! An isolated first slice of the Rust data plane. See README before use.
pub mod accounting;
mod anthropic_stream;
mod policy;
pub mod product;
pub mod product_combo;
pub mod storage;
mod translation;
use axum::{
    body::{to_bytes, Body},
    extract::{Path, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Semaphore;

const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_IN_FLIGHT: usize = 64;
const HEADER_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct ProxyState {
    client: reqwest::Client,
    upstream: reqwest::Url,
    client_key: Arc<str>,
    provider_key: HeaderValue,
    permits: Arc<Semaphore>,
    routes: Arc<HashMap<String, ModelRoute>>,
    clients: Arc<policy::ClientPolicies>,
    product_connection: Option<product::ProductConnection>,
    product_client_keys: bool,
    product_fallbacks: Arc<Vec<ProductFallback>>,
    product_combo: Option<product_combo::ProductCombo>,
}

struct ProductFallback {
    connection: product::ProductConnection,
    provider_key: HeaderValue,
}

struct ModelRoute {
    targets: Vec<ModelTarget>,
    protocol: ProviderProtocol,
    round_robin: bool,
    fallback: bool,
    cursor: AtomicUsize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProviderProtocol {
    OpenAi,
    OpenAiResponses,
    OpenAiEmbeddings,
    CohereRerank,
    Anthropic,
    OpenAiToAnthropic,
    Gemini,
}

struct ModelTarget {
    client: reqwest::Client,
    upstream: reqwest::Url,
    provider_key: HeaderValue,
    model: String,
    anthropic_bearer: bool,
    protocol: ProviderProtocol,
    product_connection: Option<product::ProductConnection>,
    product_model: Option<String>,
}

impl ProxyState {
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
            return Err("upstream must be a credential-free HTTPS chat endpoint (HTTP is allowed for literal loopback only)");
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
        })
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
        if route.protocol != ProviderProtocol::OpenAi
            || !route.fallback
            || route.round_robin
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
                || connection.upstream_url()
                    != match source.provider.as_str() {
                        "openai" => "https://api.openai.com/v1/chat/completions",
                        "openrouter" => "https://openrouter.ai/api/v1/chat/completions",
                        _ => return Err("unsupported product combo provider"),
                    }
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
            let round_robin = match object.get("strategy") {
                None => false,
                Some(v) if v.as_str() == Some("priority") => false,
                Some(v) if v.as_str() == Some("round-robin") => true,
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
                    !["url", "model", "api_key_env", "auth", "protocol"].contains(&k.as_str())
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
                });
            }
            if routes
                .insert(
                    alias.to_string(),
                    ModelRoute {
                        targets,
                        protocol,
                        round_robin,
                        fallback,
                        cursor: AtomicUsize::new(0),
                    },
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

fn allowed_address(ip: IpAddr, allow_private: bool) -> bool {
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
        .route("/v1/chat/completions", post(chat))
        .route("/v1/responses", post(responses))
        .route("/v1/embeddings", post(embeddings))
        .route("/v1/rerank", post(rerank))
        .route("/v1/messages", post(messages))
        .route("/v1beta/models/{model_action}", post(gemini))
        .with_state(state)
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (
        status,
        Json(serde_json::json!({"error": {"message": message, "type": "proxy_error"}})),
    )
        .into_response()
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
    let clients = product_access
        .as_ref()
        .map_or(state.clients.as_ref(), |access| &access.policies);
    let Some(policy) = clients.authenticate(request.headers(), protocol) else {
        return error(StatusCode::UNAUTHORIZED, "Invalid API key");
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
    if usage_accounting
        && (protocol != ProviderProtocol::OpenAi
            || !matches!(
                parsed.get("stream"),
                None | Some(serde_json::Value::Bool(false))
            )
            || parsed
                .get("service_tier")
                .is_some_and(|v| !v.is_null() && v.as_str() != Some("default")))
    {
        return error(
            StatusCode::BAD_REQUEST,
            "Usage accounting supports non-streaming OpenAI chat at the default tier only",
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
    if state.product_combo.is_none() && !policy.route_allowed(&model) {
        return error(StatusCode::FORBIDDEN, "Model is not allowed");
    }
    let route = state.routes.get(&model);
    if (route.is_none() && (!state.routes.is_empty() || protocol != ProviderProtocol::OpenAi))
        || route.is_some_and(|route| {
            route.protocol != protocol
                && !(protocol == ProviderProtocol::OpenAi
                    && route.protocol == ProviderProtocol::OpenAiToAnthropic)
        })
    {
        return error(StatusCode::NOT_FOUND, "Unknown model route");
    }
    let eligible: Vec<_> = route.map_or_else(Vec::new, |route| {
        route
            .targets
            .iter()
            .filter(|target| {
                policy.target_allowed(target.product_model.as_deref().unwrap_or(&target.model))
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
    let start = route.map_or(0, |route| {
        if route.round_robin {
            route.cursor.fetch_add(1, Ordering::Relaxed) % eligible.len()
        } else {
            0
        }
    });
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
        let target = route.map(|_| eligible[(start + offset) % eligible.len()]);
        if let Some(combo) = &state.product_combo {
            let Some(target) = target else { break };
            let Some(connection) = &target.product_connection else {
                continue;
            };
            let Some(candidate) = &product_candidate else {
                break;
            };
            if !combo.unchanged().await || !connection.unchanged().await {
                continue;
            }
            let access = match connection
                .client_policies(candidate, Some(combo.name()))
                .await
            {
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
                Ok(prices) => prices,
                Err(_) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Explicit model pricing unavailable",
                    )
                }
            };
            Some((connection.clone(), target_model.to_owned(), prices))
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
                let provider_key = if product_access.is_some() && product_index > 0 {
                    &state.product_fallbacks[product_index - 1].provider_key
                } else {
                    &state.provider_key
                };
                (&state.client, &state.upstream, provider_key, payload)
            }
        };
        let mut target_url = url.clone();
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
        let response = match tokio::time::timeout(HEADER_TIMEOUT, upstream.send()).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) if offset + 1 < attempts => continue,
            Err(_) if offset + 1 < attempts => continue,
            Ok(Err(_)) => return error(StatusCode::BAD_GATEWAY, "Upstream unavailable"),
            Err(_) => return error(StatusCode::GATEWAY_TIMEOUT, "Upstream response timed out"),
        };
        if (response.status() == StatusCode::TOO_MANY_REQUESTS
            || response.status().is_server_error())
            && offset + 1 < attempts
        {
            last_retry_response = Some(response);
            continue;
        }
        final_translated = translate_anthropic;
        final_accounting = accounting_attempt;
        final_response = Some(response);
        break;
    }
    let Some(response) = final_response.or(last_retry_response) else {
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
                let _keep_alive = (&permit, &client_permit);
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
        if let Some((connection, model, prices)) = final_accounting {
            let Some(access) = &product_access else {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Usage accounting unavailable",
                );
            };
            let status = response.status();
            let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
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
                    accounting::ChatUsage::from_response(&v).ok()
                });
            let Some(usage) = usage else {
                return error(
                    StatusCode::BAD_GATEWAY,
                    "Provider response is missing valid token usage",
                );
            };
            if connection
                .record_usage(&access.key_id, &model, &usage, &prices)
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
        let _keep_alive = (&permit, &client_permit);
        chunk
    });
    let mut result = Response::new(Body::from_stream(stream));
    *result.status_mut() = status;
    *result.headers_mut() = headers;
    result
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
}
