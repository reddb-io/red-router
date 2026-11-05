//! An isolated first slice of the Rust data plane. See README before use.
pub mod storage;
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use std::{net::IpAddr, sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
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
}

impl ProxyState {
    /// The operator configures one endpoint. DNS is resolved and pinned at startup.
    pub async fn new(
        upstream: &str,
        client_key: &str,
        provider_key: &str,
        allow_private: bool,
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
            || !upstream.path().ends_with("/chat/completions")
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
        let mut provider_key = HeaderValue::from_str(&format!("Bearer {provider_key}"))
            .map_err(|_| "invalid provider key")?;
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
        })
    }
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
        .with_state(state)
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (
        status,
        Json(serde_json::json!({"error": {"message": message, "type": "proxy_error"}})),
    )
        .into_response()
}

fn authorized(headers: &HeaderMap, expected: &str) -> bool {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let Some(value) = values.next() else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    let Ok(value) = value.to_str() else {
        return false;
    };
    let Some(candidate) = value.strip_prefix("Bearer ") else {
        return false;
    };
    bool::from(candidate.as_bytes().ct_eq(expected.as_bytes()))
}

async fn chat(State(state): State<ProxyState>, request: Request) -> Response {
    if !authorized(request.headers(), &state.client_key) {
        return error(StatusCode::UNAUTHORIZED, "Invalid API key");
    }
    let permit = match state.permits.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return error(StatusCode::TOO_MANY_REQUESTS, "Proxy is at capacity"),
    };
    let accept = request.headers().get(header::ACCEPT).cloned();
    let body = match to_bytes(request.into_body(), MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"),
    };
    let parsed: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid JSON request"),
    };
    if !parsed
        .get("model")
        .and_then(|model| model.as_str())
        .is_some_and(|model| !model.is_empty())
    {
        return error(StatusCode::BAD_REQUEST, "A model is required");
    }
    let mut upstream = state
        .client
        .post(state.upstream.clone())
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, state.provider_key.clone())
        .body(body);
    if let Some(accept) = accept {
        upstream = upstream.header(header::ACCEPT, accept);
    }
    let response = match tokio::time::timeout(HEADER_TIMEOUT, upstream.send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => return error(StatusCode::BAD_GATEWAY, "Upstream unavailable"),
        Err(_) => return error(StatusCode::GATEWAY_TIMEOUT, "Upstream response timed out"),
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
        let _keep_alive = &permit;
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
