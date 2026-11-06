use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Router,
};
use futures_util::{stream, StreamExt};
use red_routerd::{router, ProxyState};
use std::{io, sync::Arc, time::Duration};
use tokio::sync::{oneshot, Mutex};

#[tokio::test]
async fn anthropic_messages_preserve_protocol_and_isolate_credentials() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let provider = Router::new().route(
        "/v1/messages",
        post(move |headers: HeaderMap, body: String| {
            let observed = observed.clone();
            async move {
                observed.fetch_add(1, Ordering::SeqCst);
                assert_eq!(headers.get("x-api-key").unwrap(), "provider-secret");
                assert!(headers.get(header::AUTHORIZATION).is_none());
                assert_eq!(headers.get("anthropic-version").unwrap(), "2023-06-01");
                assert_eq!(headers.get("anthropic-beta").unwrap(), "feature-example");
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&body).unwrap()["model"],
                    "claude-provider-model"
                );
                (
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    "event: message_stop\ndata: {}\n\n",
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let config = serde_json::json!([{"model":"claude-route", "protocol":"anthropic", "targets":[{
        "url":format!("http://{addr}/v1/messages"), "model":"claude-provider-model", "api_key_env":"ANTHROPIC_KEY"
    }]}]).to_string();
    let state = ProxyState::new(
        &format!("http://{addr}/v1/chat/completions"),
        "client-key-12345678",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(&config, |_| Some("provider-secret".into()), false)
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let proxy_task =
        tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let body = r#"{"model":"claude-route","stream":true,"messages":[]}"#;
    let send = |path: &str| client.post(format!("{base}{path}")).body(body);
    assert_eq!(
        send("/v1/messages")
            .header("x-api-key", "bad")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send("/v1/messages")
            .header("x-api-key", "client-key-12345678")
            .bearer_auth("client-key-12345678")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send("/v1/chat/completions")
            .bearer_auth("client-key-12345678")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let response = send("/v1/messages")
        .header("x-api-key", "client-key-12345678")
        .header("anthropic-beta", "feature-example")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/event-stream"
    );
    assert_eq!(
        response.text().await.unwrap(),
        "event: message_stop\ndata: {}\n\n"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    proxy_task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn refuses_insecure_upstreams_and_weak_keys() {
    assert!(ProxyState::new(
        "http://192.0.2.1/v1/chat/completions",
        "a-long-client-key",
        "provider",
        false
    )
    .await
    .is_err());
    assert!(ProxyState::new(
        "http://127.0.0.1/v1/chat/completions",
        "short",
        "provider",
        false
    )
    .await
    .is_err());
    assert!(ProxyState::new(
        "http://user@127.0.0.1/v1/chat/completions",
        "a-long-client-key",
        "provider",
        false
    )
    .await
    .is_err());
    assert!(ProxyState::new(
        "https://169.254.169.254/v1/chat/completions",
        "a-long-client-key",
        "provider",
        true
    )
    .await
    .is_err());
}

#[tokio::test]
async fn rejects_invalid_route_configuration() {
    let state = ProxyState::new(
        "http://127.0.0.1:12345/v1/chat/completions",
        "local-client-key-123",
        "provider",
        false,
    )
    .await
    .unwrap();
    let target = serde_json::json!({"url":"http://127.0.0.1:12345/v1/chat/completions", "model":"model", "api_key_env":"PROVIDER_KEY"});
    for config in [
        serde_json::json!([]),
        serde_json::json!([{"model":"a", "strategy":9, "targets":[target]}]),
        serde_json::json!([{"model":"a", "fallback":"true", "targets":[target]}]),
        serde_json::json!([{"model":"a", "targets":[]}]),
        serde_json::json!([{"model":"a", "targets":[target], "unknown":true}]),
        serde_json::json!([{"model":"a", "targets":[target]}, {"model":"a", "targets":[target]}]),
    ] {
        assert!(state
            .clone()
            .with_routes(&config.to_string(), |_| Some("provider".into()), false)
            .await
            .is_err());
    }
    let config = serde_json::json!([{"model":"a", "targets":[target]}]).to_string();
    assert!(state.with_routes(&config, |_| None, false).await.is_err());
}

#[tokio::test]
async fn client_policies_restrict_routes_and_skip_blocked_targets() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let calls = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&calls);
    let provider = Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap, body: String| {
            let seen = Arc::clone(&seen);
            async move {
                seen.fetch_add(1, Ordering::SeqCst);
                assert_eq!(
                    headers.get(header::AUTHORIZATION).unwrap(),
                    "Bearer allowed-key"
                );
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&body).unwrap()["model"],
                    "vendor/allowed"
                );
                "allowed"
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let provider_task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let route_config = serde_json::json!([{"model":"combo", "targets":[
        {"url":upstream,"model":"vendor/blocked","api_key_env":"BLOCKED_KEY"},
        {"url":upstream,"model":"vendor/allowed","api_key_env":"ALLOWED_KEY"}
    ]}])
    .to_string();
    let policies = serde_json::json!([
        {"api_key_env":"CLIENT_ONE","allowed_routes":["combo"],"blocked_models":["vendor/blocked"]},
        {"api_key_env":"CLIENT_DISABLED","enabled":false}
    ])
    .to_string();
    let state = ProxyState::new(&upstream, "default-client-key-123", "default", false)
        .await
        .unwrap()
        .with_routes(
            &route_config,
            |name| match name {
                "BLOCKED_KEY" => Some("blocked-key".into()),
                "ALLOWED_KEY" => Some("allowed-key".into()),
                _ => None,
            },
            false,
        )
        .await
        .unwrap()
        .with_client_policies(&policies, |name| match name {
            "CLIENT_ONE" => Some("client-one-key-12345".into()),
            "CLIENT_DISABLED" => Some("disabled-key-123456".into()),
            _ => None,
        })
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let task = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = |key: &str, model: &str| {
        client
            .post(&url)
            .bearer_auth(key)
            .body(serde_json::json!({"model":model}).to_string())
            .send()
    };
    assert_eq!(
        send("default-client-key-123", "combo")
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send("disabled-key-123456", "combo").await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send("client-one-key-12345", "elsewhere")
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let response = send("client-one-key-12345", "combo").await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "allowed");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn client_policies_fail_closed_when_invalid() {
    let state = ProxyState::new(
        "http://127.0.0.1:12345/v1/chat/completions",
        "default-client-key-123",
        "provider",
        false,
    )
    .await
    .unwrap();
    for value in [
        serde_json::json!([]),
        serde_json::json!([{"api_key_env":"KEY","allowed_routes":"all"}]),
        serde_json::json!([{"api_key_env":"KEY","blocked_models":["ab*cd"]}]),
        serde_json::json!([{"api_key_env":"KEY","enabled":"true"}]),
        serde_json::json!([{"api_key_env":"KEY","max_concurrent_requests":0}]),
        serde_json::json!([{"api_key_env":"KEY","max_concurrent_requests":65}]),
        serde_json::json!([{"api_key_env":"KEY","max_concurrent_requests":"1"}]),
        serde_json::json!([{"api_key_env":"KEY"},{"api_key_env":"KEY"}]),
        serde_json::json!([{"api_key_env":"KEY","unrecognized":true}]),
    ] {
        assert!(state
            .clone()
            .with_client_policies(&value.to_string(), |_| Some("client-key-12345678".into()))
            .is_err());
    }
    assert!(state
        .with_client_policies(r#"[{"api_key_env":"MISSING"}]"#, |_| None)
        .is_err());
}

#[tokio::test]
async fn responses_passthrough_enforces_concurrency_per_client_until_stream_end() {
    let (release, wait) = oneshot::channel::<()>();
    let wait = Arc::new(Mutex::new(Some(wait)));
    let mock = Router::new().route(
        "/v1/responses",
        post(move |headers: HeaderMap, body: String| {
            let wait = Arc::clone(&wait);
            async move {
                assert_eq!(
                    headers.get(header::AUTHORIZATION).unwrap(),
                    "Bearer upstream-secret"
                );
                let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                assert_eq!(value["model"], "provider-responses-model");
                assert_eq!(value["input"], "hello");
                if value["hold"] == true {
                    let wait = wait.lock().await.take().unwrap();
                    let first = stream::once(async {
                        Ok::<_, io::Error>(Bytes::from_static(
                            b"event: response.created\ndata: {}\n\n",
                        ))
                    });
                    let last = stream::once(async move {
                        let _ = wait.await;
                        Ok::<_, io::Error>(Bytes::from_static(
                            b"event: response.completed\ndata: {}\n\n",
                        ))
                    });
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        Body::from_stream(first.chain(last)),
                    )
                        .into_response()
                } else {
                    (
                        [(header::CONTENT_TYPE, "application/json")],
                        r#"{"object":"response"}"#,
                    )
                        .into_response()
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mock_task = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    let config = serde_json::json!([{"model":"responses-route","protocol":"openai-responses","targets":[{
        "url":format!("http://{addr}/v1/responses"),"model":"provider-responses-model","api_key_env":"UPSTREAM_KEY"
    }]}]).to_string();
    let policies = serde_json::json!([
        {"api_key_env":"CLIENT_ONE","max_concurrent_requests":1},
        {"api_key_env":"CLIENT_TWO","max_concurrent_requests":1}
    ])
    .to_string();
    let state = ProxyState::new(
        &format!("http://{addr}/v1/chat/completions"),
        "default-client-key-123",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(&config, |_| Some("upstream-secret".into()), false)
    .await
    .unwrap()
    .with_client_policies(&policies, |name| match name {
        "CLIENT_ONE" => Some("first-client-key-123".into()),
        "CLIENT_TWO" => Some("other-client-key-123".into()),
        _ => None,
    })
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = |path: &str, key: &str, hold: bool| {
        client.post(format!("{base}{path}"))
        .bearer_auth(key).body(serde_json::json!({"model":"responses-route","input":"hello","stream":true,"hold":hold}).to_string()).send()
    };
    let mut first = send("/v1/responses", "first-client-key-123", true)
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(
        first.chunk().await.unwrap().unwrap(),
        "event: response.created\ndata: {}\n\n"
    );
    assert_eq!(
        send("/v1/responses", "first-client-key-123", false)
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        send("/v1/chat/completions", "other-client-key-123", false)
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send("/v1/responses", "other-client-key-123", false)
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    release.send(()).unwrap();
    assert_eq!(
        first.text().await.unwrap(),
        "event: response.completed\ndata: {}\n\n"
    );
    assert_eq!(
        send("/v1/responses", "first-client-key-123", false)
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    task.abort();
    mock_task.abort();
}

#[tokio::test]
async fn authenticates_separates_credentials_and_streams_incrementally() {
    let (release, wait) = oneshot::channel::<()>();
    let wait = Arc::new(Mutex::new(Some(wait)));
    let mock = Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap, body: String| {
            let wait = wait.clone();
            async move {
                assert_eq!(
                    headers.get(header::AUTHORIZATION).unwrap(),
                    "Bearer upstream-secret"
                );
                if body.contains("redirect") {
                    return (
                        StatusCode::TEMPORARY_REDIRECT,
                        [(header::LOCATION, "http://169.254.169.254/")],
                        Body::empty(),
                    )
                        .into_response();
                }
                let wait = wait.lock().await.take().unwrap();
                let first = stream::once(async {
                    Ok::<_, io::Error>(Bytes::from_static(b"data: first\n\n"))
                });
                let last = stream::once(async move {
                    let _ = wait.await;
                    Ok::<_, io::Error>(Bytes::from_static(b"data: [DONE]\n\n"))
                });
                (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    Body::from_stream(first.chain(last)),
                )
                    .into_response()
            }
        }),
    );
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move { axum::serve(upstream, mock).await.unwrap() });
    let state = ProxyState::new(
        &format!("http://{upstream_addr}/v1/chat/completions"),
        "local-client-key-123",
        "upstream-secret",
        false,
    )
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let url = format!("http://{addr}/v1/chat/completions");
    assert_eq!(
        client.post(&url).body("{}").send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(&url)
            .bearer_auth("local-client-key-123")
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .post(&url)
            .bearer_auth("local-client-key-123")
            .body("x".repeat(2 * 1024 * 1024 + 1))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let redirect = client
        .post(&url)
        .bearer_auth("local-client-key-123")
        .body(r#"{"model":"redirect"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(redirect.status(), StatusCode::BAD_GATEWAY);
    let mut response = client
        .post(&url)
        .bearer_auth("local-client-key-123")
        .body(r#"{"model":"test","stream":true}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let first = tokio::time::timeout(Duration::from_secs(2), response.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(first, "data: first\n\n");
    release.send(()).unwrap();
    assert_eq!(response.text().await.unwrap(), "data: [DONE]\n\n");
    task.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn routes_models_with_priority_round_robin_and_opt_in_fallback() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let calls = Arc::new([AtomicUsize::new(0), AtomicUsize::new(0)]);
    let mut addresses = Vec::new();
    let mut providers = Vec::new();
    for index in 0..2 {
        let calls = calls.clone();
        let provider = Router::new().route(
            "/v1/chat/completions",
            post(move |headers: HeaderMap, body: String| {
                let calls = calls.clone();
                async move {
                    calls[index].fetch_add(1, Ordering::Relaxed);
                    let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                    assert_eq!(
                        headers
                            .get(header::AUTHORIZATION)
                            .unwrap()
                            .to_str()
                            .unwrap(),
                        format!("Bearer secret-{index}")
                    );
                    assert_eq!(value["model"], format!("provider-model-{index}"));
                    if index == 0 && value["marker"] == "fail" {
                        return (StatusCode::SERVICE_UNAVAILABLE, "unavailable".to_string());
                    }
                    if index == 0 && value["marker"] == "bad" {
                        return (StatusCode::BAD_REQUEST, "bad request".to_string());
                    }
                    (StatusCode::OK, format!("provider-{index}"))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        addresses.push(listener.local_addr().unwrap());
        providers.push(tokio::spawn(async move {
            axum::serve(listener, provider).await.unwrap()
        }));
    }
    let targets = serde_json::json!((0..2)
        .map(|index| serde_json::json!({
            "url": format!("http://{}/v1/chat/completions", addresses[index]),
            "model": format!("provider-model-{index}"),
            "api_key_env": format!("KEY_{index}"),
        }))
        .collect::<Vec<_>>());
    let config = serde_json::json!([
        {"model":"primary", "strategy":"priority", "fallback":true, "targets":targets},
        {"model":"balanced", "strategy":"round-robin", "targets":targets}
    ])
    .to_string();
    let state = ProxyState::new(
        &format!("http://{}/v1/chat/completions", addresses[0]),
        "local-client-key-123",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(
        &config,
        |name| match name {
            "KEY_0" => Some("secret-0".into()),
            "KEY_1" => Some("secret-1".into()),
            _ => None,
        },
        false,
    )
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let task = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = |model: &str, marker: &str| {
        client
            .post(&url)
            .bearer_auth("local-client-key-123")
            .body(serde_json::json!({"model":model,"marker":marker}).to_string())
            .send()
    };
    assert_eq!(
        send("primary", "ok").await.unwrap().text().await.unwrap(),
        "provider-0"
    );
    assert_eq!(
        send("primary", "fail").await.unwrap().text().await.unwrap(),
        "provider-1"
    );
    let before = calls[1].load(Ordering::Relaxed);
    assert_eq!(
        send("primary", "bad").await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(calls[1].load(Ordering::Relaxed), before);
    assert_eq!(
        send("balanced", "ok").await.unwrap().text().await.unwrap(),
        "provider-0"
    );
    assert_eq!(
        send("balanced", "ok").await.unwrap().text().await.unwrap(),
        "provider-1"
    );
    assert_eq!(
        send("unknown", "ok").await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    task.abort();
    for provider in providers {
        provider.abort();
    }
}
