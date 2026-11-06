//! An isolated first slice of the Rust data plane. See README before use.
mod policy;
pub mod storage;
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
    Anthropic,
    Gemini,
}

struct ModelTarget {
    client: reqwest::Client,
    upstream: reqwest::Url,
    provider_key: HeaderValue,
    model: String,
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
                ProviderProtocol::Anthropic => "/messages",
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
            | ProviderProtocol::OpenAiEmbeddings => {
                format!("Bearer {provider_key}")
            }
            ProviderProtocol::Anthropic | ProviderProtocol::Gemini => provider_key.to_owned(),
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
        })
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
                Some(value) if value.as_str() == Some("anthropic") => ProviderProtocol::Anthropic,
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
                if target
                    .keys()
                    .any(|k| !["url", "model", "api_key_env"].contains(&k.as_str()))
                {
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
                let proxy =
                    Self::new_for_protocol(url, &self.client_key, &secret, allow_private, protocol)
                        .await?;
                targets.push(ModelTarget {
                    client: proxy.client,
                    upstream: proxy.upstream,
                    provider_key: proxy.provider_key,
                    model: model.to_string(),
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
    let Some(policy) = state.clients.authenticate(request.headers(), protocol) else {
        return error(StatusCode::UNAUTHORIZED, "Invalid API key");
    };
    let category = if protocol == ProviderProtocol::OpenAiEmbeddings {
        "embeddings"
    } else {
        "chat"
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
    if !policy.route_allowed(&model) {
        return error(StatusCode::FORBIDDEN, "Model is not allowed");
    }
    let route = state.routes.get(&model);
    if (route.is_none() && (!state.routes.is_empty() || protocol != ProviderProtocol::OpenAi))
        || route.is_some_and(|route| route.protocol != protocol)
    {
        return error(StatusCode::NOT_FOUND, "Unknown model route");
    }
    let eligible: Vec<_> = route.map_or_else(Vec::new, |route| {
        route
            .targets
            .iter()
            .filter(|target| policy.target_allowed(&target.model))
            .collect()
    });
    if route.is_none() && !policy.target_allowed(&model) {
        return error(StatusCode::FORBIDDEN, "Model is not allowed");
    }
    if route.is_some() && eligible.is_empty() {
        return error(StatusCode::FORBIDDEN, "No permitted route target");
    }
    let start = route.map_or(0, |route| {
        if route.round_robin {
            route.cursor.fetch_add(1, Ordering::Relaxed) % eligible.len()
        } else {
            0
        }
    });
    let attempts = route.map_or(1, |route| if route.fallback { eligible.len() } else { 1 });
    let mut final_response = None;
    for offset in 0..attempts {
        let target = route.map(|_| eligible[(start + offset) % eligible.len()]);
        let (client, url, provider_key, payload) = match target {
            Some(target) => {
                if protocol != ProviderProtocol::Gemini {
                    parsed["model"] = serde_json::Value::String(target.model.clone());
                }
                let payload = match serde_json::to_vec(&parsed) {
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
            None => (
                &state.client,
                &state.upstream,
                &state.provider_key,
                body.to_vec(),
            ),
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
                upstream = upstream
                    .header("x-api-key", provider_key.clone())
                    .header("anthropic-version", version.clone());
                if let Some(beta) = beta {
                    upstream = upstream.header("anthropic-beta", beta.clone());
                }
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
            continue;
        }
        final_response = Some(response);
        break;
    }
    let Some(response) = final_response else {
        return error(StatusCode::BAD_GATEWAY, "Upstream unavailable");
    };
    // Redirects are intentionally not followed or relayed to the client.
    if response.status().is_redirection() {
        return error(StatusCode::BAD_GATEWAY, "Upstream redirect refused");
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
