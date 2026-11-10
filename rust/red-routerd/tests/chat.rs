use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Router,
};
use futures_util::{stream, StreamExt};
use red_routerd::{router, ProxyState};
use std::{
    io,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{oneshot, Mutex};

#[tokio::test]
async fn antigravity_native_route_preserves_envelope_and_official_cli_identity() {
    use axum::extract::Request;

    let provider = Router::new().route(
        "/v1internal:streamGenerateContent",
        post(|request: Request| async move {
            assert_eq!(
                request.headers()[header::AUTHORIZATION],
                "Bearer antigravity-access-token"
            );
            assert_eq!(
                request.headers()[header::ACCEPT],
                "text/event-stream"
            );
            assert_eq!(request.headers()["x-goog-user-project"], "gcp-project-1");
            assert_eq!(
                request.headers()[header::USER_AGENT],
                "antigravity/cli/1.1.5 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)"
            );
            assert_eq!(request.uri().query(), Some("alt=sse"));
            let body = axum::body::to_bytes(request.into_body(), 16 * 1024)
                .await
                .unwrap();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["model"], "gemini-2.5-pro");
            assert_eq!(body["project"], "gcp-project-1");
            assert_eq!(body["request"]["contents"][0]["parts"][0]["text"], "hello");
            (
                [(header::CONTENT_TYPE, "text/event-stream")],
                "data: {\"response\":{\"candidates\":[{\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":1,\"candidatesTokenCount\":1,\"totalTokenCount\":2}}}\n\n",
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let routes = serde_json::json!([{
        "model":"antigravity-route",
        "protocol":"antigravity",
        "targets":[{
            "url":format!("http://{address}/v1internal:streamGenerateContent"),
            "model":"gemini-2.5-pro",
            "api_key_env":"ANTIGRAVITY_TOKEN"
        }]
    }])
    .to_string();
    let state = ProxyState::new(
        &format!("http://{address}/v1/chat/completions"),
        "client-key-12345678",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(&routes, |_| Some("antigravity-access-token".into()), false)
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let proxy_task =
        tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(format!("{base}/v1/antigravity"))
        .bearer_auth("client-key-12345678")
        .json(&serde_json::json!({
            "model":"antigravity-route",
            "project":"gcp-project-1",
            "userAgent":"antigravity",
            "requestType":"agent",
            "request":{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.text().await.unwrap().contains("usageMetadata"));
    proxy_task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn antigravity_retries_project_scoped_forbidden_without_billing_header() {
    use axum::extract::Request;

    let sends = Arc::new(AtomicUsize::new(0));
    let provider_sends = sends.clone();
    let provider = Router::new().route(
        "/v1internal:streamGenerateContent",
        post(move |request: Request| {
            let sends = provider_sends.clone();
            async move {
                assert_eq!(
                    request.headers()[header::AUTHORIZATION],
                    "Bearer antigravity-access-token"
                );
                let send = sends.fetch_add(1, Ordering::SeqCst);
                if send == 0 {
                    assert_eq!(
                        request.headers()["x-goog-user-project"],
                        "forbidden-project"
                    );
                    return StatusCode::FORBIDDEN.into_response();
                }
                assert!(request.headers().get("x-goog-user-project").is_none());
                (
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    "data: {\"response\":{\"candidates\":[{\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":1,\"candidatesTokenCount\":1,\"totalTokenCount\":2}}}\n\n",
                )
                    .into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let routes = serde_json::json!([{
        "model":"antigravity-route",
        "protocol":"antigravity",
        "targets":[{
            "url":format!("http://{address}/v1internal:streamGenerateContent"),
            "model":"gemini-2.5-pro",
            "api_key_env":"ANTIGRAVITY_TOKEN"
        }]
    }])
    .to_string();
    let state = ProxyState::new(
        &format!("http://{address}/v1/chat/completions"),
        "client-key-12345678",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(&routes, |_| Some("antigravity-access-token".into()), false)
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let proxy_task =
        tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(format!("{base}/v1/antigravity"))
        .bearer_auth("client-key-12345678")
        .json(&serde_json::json!({
            "model":"antigravity-route",
            "project":"forbidden-project",
            "request":{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(sends.load(Ordering::SeqCst), 2);
    assert!(response.text().await.unwrap().contains("usageMetadata"));
    proxy_task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn anthropic_native_route_can_use_bearer_provider_authentication() {
    let provider = Router::new().route(
        "/v1/messages",
        post(|headers: HeaderMap, body: String| async move {
            assert_eq!(headers[header::AUTHORIZATION], "Bearer upstream-bearer-key");
            assert!(headers.get("x-api-key").is_none());
            assert_eq!(headers["anthropic-version"], "2023-06-01");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap()["model"],
                "provider/model"
            );
            "native-result"
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let routes = serde_json::json!([{"model":"native-alias","protocol":"anthropic","targets":[{
        "url":format!("http://{addr}/v1/messages"),"model":"provider/model","api_key_env":"KEY","auth":"bearer"
    }]}]).to_string();
    let state = ProxyState::new(
        &format!("http://{addr}/v1/chat/completions"),
        "client-key-12345678",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(&routes, |_| Some("upstream-bearer-key".into()), false)
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", "client-key-12345678")
        .body(r#"{"model":"native-alias","messages":[]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "native-result");
    task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn openai_to_anthropic_streams_text_and_incremental_tool_arguments() {
    let (release, wait) = oneshot::channel::<()>();
    let wait = Arc::new(Mutex::new(Some(wait)));
    let provider = Router::new().route("/v1/messages", post(move |headers: HeaderMap, body: String| {
        let wait = wait.clone();
        async move {
            assert_eq!(headers["x-api-key"], "anthropic-upstream-key");
            let body: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["stream"], true);
            let first = concat!(
                "event: message_start\r\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-target\",\"usage\":{\"input_tokens\":5,\"cache_creation_input_tokens\":2,\"cache_read_input_tokens\":3}}}\r\n\r\n",
                "event: content_block_start\r\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\r\n\r\n",
                "event: content_block_delta\r\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Olá\"}}\r\n\r\n"
            );
            let pieces: Vec<_> = first.as_bytes().chunks(3).map(|bytes| Ok::<_, io::Error>(Bytes::copy_from_slice(bytes))).collect();
            let wait = wait.lock().await.take().unwrap();
            let last = stream::once(async move {
                let _ = wait.await;
                Ok::<_, io::Error>(Bytes::from_static(concat!(
                    "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                    "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool_1\",\"name\":\"weather\",\"input\":{}}}\n\n",
                    "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"city\\\":\"}}\n\n",
                    "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"Rome\\\"}\"}}\n\n",
                    "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
                    "data: {\"type\":\"content_block_start\",\"index\":3,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool_2\",\"name\":\"clock\",\"input\":{}}}\n\n",
                    "data: {\"type\":\"content_block_stop\",\"index\":3}\n\n",
                    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":3}}\n\n",
                    "data: {\"type\":\"message_stop\"}\n\n"
                ).as_bytes()))
            });
            ([(header::CONTENT_TYPE, "text/event-stream")], Body::from_stream(stream::iter(pieces).chain(last)))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let routes = serde_json::json!([{"model":"claude-alias","protocol":"openai-to-anthropic","targets":[{
        "url":format!("http://{addr}/v1/messages"),"model":"claude-target","api_key_env":"ANTHROPIC_KEY"
    }]}]).to_string();
    let state = ProxyState::new(
        &format!("http://{addr}/v1/chat/completions"),
        "client-key-12345678",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(&routes, |_| Some("anthropic-upstream-key".into()), false)
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut response = client.post(format!("{base}/v1/chat/completions")).bearer_auth("client-key-12345678")
        .body(r#"{"model":"claude-alias","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"hello"}]}"#)
        .send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut bytes = Vec::new();
    while !bytes
        .windows("Olá".len())
        .any(|part| part == "Olá".as_bytes())
    {
        let next = tokio::time::timeout(Duration::from_secs(5), response.chunk())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        bytes.extend_from_slice(&next);
    }
    assert!(!bytes.windows(6).any(|part| part == b"[DONE]"));
    release.send(()).unwrap();
    bytes.extend_from_slice(&response.bytes().await.unwrap());
    let output = String::from_utf8(bytes).unwrap();
    let events: Vec<serde_json::Value> = output
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter(|line| *line != "[DONE]")
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let mut arguments = String::new();
    let mut empty_arguments = String::new();
    for event in &events {
        if let Some(call) = event.pointer("/choices/0/delta/tool_calls/0") {
            if let Some(fragment) = call.pointer("/function/arguments").and_then(|v| v.as_str()) {
                match call.get("index").and_then(|value| value.as_u64()) {
                    Some(0) => arguments.push_str(fragment),
                    Some(1) => empty_arguments.push_str(fragment),
                    _ => panic!("unexpected tool index"),
                }
            }
        }
    }
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&arguments).unwrap()["city"],
        "Rome"
    );
    assert_eq!(empty_arguments, "{}");
    assert!(events
        .iter()
        .any(|event| event.pointer("/choices/0/finish_reason")
            == Some(&serde_json::json!("tool_calls"))));
    assert!(events
        .iter()
        .any(|event| event.pointer("/usage/total_tokens") == Some(&serde_json::json!(13))));
    assert!(events.iter().any(
        |event| event.pointer("/usage/prompt_tokens_details/cached_tokens")
            == Some(&serde_json::json!(3))
    ));
    assert!(output.ends_with("data: [DONE]\n\n"));
    task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn openai_to_anthropic_truncated_stream_is_not_reported_as_complete() {
    let provider = Router::new().route("/v1/messages", post(|| async {
        ([(header::CONTENT_TYPE, "text/event-stream")], "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"target\",\"usage\":{\"input_tokens\":1}}}\n\n")
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let routes = serde_json::json!([{"model":"alias","protocol":"openai-to-anthropic","targets":[{
        "url":format!("http://{addr}/v1/messages"),"model":"target","api_key_env":"KEY"
    }]}])
    .to_string();
    let state = ProxyState::new(
        &format!("http://{addr}/v1/chat/completions"),
        "client-key-12345678",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(&routes, |_| Some("provider-key".into()), false)
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let response = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("client-key-12345678")
        .body(r#"{"model":"alias","stream":true,"messages":[{"role":"user","content":"hello"}]}"#)
        .send()
        .await;
    let mut data = Vec::new();
    let mut failed = response.is_err();
    if let Ok(mut response) = response {
        loop {
            match response.chunk().await {
                Ok(Some(bytes)) => data.extend_from_slice(&bytes),
                Ok(None) => break,
                Err(_) => {
                    failed = true;
                    break;
                }
            }
        }
    }
    assert!(failed, "a truncated provider stream must fail");
    assert!(!data.windows(6).any(|part| part == b"[DONE]"));
    task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn openai_to_anthropic_translates_tool_history_and_response_without_leaking_keys() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let provider = Router::new().route("/v1/messages", post(move |headers: HeaderMap, body: String| {
        let seen = seen.clone();
        async move {
            seen.fetch_add(1, Ordering::SeqCst);
            assert_eq!(headers[header::AUTHORIZATION], "Bearer anthropic-upstream-key");
            assert_eq!(headers["anthropic-version"], "2023-06-01");
            assert!(headers.get("x-api-key").is_none());
            let body: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["model"], "claude-target");
            assert_eq!(body["system"][0]["text"], "Be concise");
            assert_eq!(body["messages"][1]["content"][0]["input"]["city"], "Paris");
            assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "call_1");
            assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
            assert_eq!(body["tool_choice"]["disable_parallel_tool_use"], true);
            ([(header::CONTENT_TYPE, "application/json")], r#"{"id":"msg_123","model":"claude-target","content":[{"type":"text","text":"Checking"},{"type":"tool_use","id":"tool_2","name":"weather","input":{"city":"Rome"}}],"stop_reason":"tool_use","usage":{"input_tokens":7,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":4}}"#)
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let routes = serde_json::json!([{"model":"claude-alias","protocol":"openai-to-anthropic","targets":[{
        "url":format!("http://{addr}/v1/messages"),"model":"claude-target","api_key_env":"ANTHROPIC_KEY","auth":"bearer"
    }]}]).to_string();
    let state = ProxyState::new(
        &format!("http://{addr}/v1/chat/completions"),
        "client-key-12345678",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(&routes, |_| Some("anthropic-upstream-key".into()), false)
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let body = serde_json::json!({"model":"claude-alias","max_tokens":64,"messages":[
        {"role":"system","content":"Be concise"}, {"role":"user","content":"Weather?"},
        {"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\"city\":\"Paris\"}"}}]},
        {"role":"tool","tool_call_id":"call_1","content":"sunny"}],
        "tools":[{"type":"function","function":{"name":"weather","parameters":{"type":"object"}}}],"tool_choice":"auto","parallel_tool_calls":false});
    let mut invalid = body.clone();
    invalid["response_format"] = serde_json::json!({"type":"json_object"});
    let send = |value: &serde_json::Value| {
        client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth("client-key-12345678")
            .body(value.to_string())
            .send()
    };
    assert_eq!(
        send(&invalid).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    let mut stream = body.clone();
    stream["stream"] = serde_json::json!("invalid");
    assert_eq!(
        send(&stream).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    let response = send(&body).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let result: serde_json::Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(result["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(result["choices"][0]["message"]["content"], "Checking");
    assert_eq!(
        result["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "weather"
    );
    let args: serde_json::Value = serde_json::from_str(
        result["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(args["city"], "Rome");
    assert_eq!(result["usage"]["total_tokens"], 16);
    assert_eq!(result["usage"]["prompt_tokens_details"]["cached_tokens"], 3);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn cohere_rerank_preserves_payload_and_enforces_per_client_rate_limit() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = Arc::new(AtomicUsize::new(0));
    let failures = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let failed_attempts = failures.clone();
    let provider = Router::new()
        .route(
            "/first/rerank",
            post(move || {
                let failed_attempts = failed_attempts.clone();
                async move {
                    failed_attempts.fetch_add(1, Ordering::SeqCst);
                    StatusCode::SERVICE_UNAVAILABLE
                }
            }),
        )
        .route(
            "/v2/rerank",
            post(move |headers: HeaderMap, body: String| {
                let seen = seen.clone();
                async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        headers[header::AUTHORIZATION],
                        "Bearer cohere-provider-secret"
                    );
                    let body: serde_json::Value = serde_json::from_str(&body).unwrap();
                    assert_eq!(body["model"], "rerank-v3.5");
                    assert_eq!(body["query"], "needle");
                    assert_eq!(body["documents"], serde_json::json!(["first", "second"]));
                    assert_eq!(body["top_n"], 1);
                    (
                        [(header::CONTENT_TYPE, "application/json")],
                        r#"{"results":[{"index":1,"relevance_score":0.9}]}"#,
                    )
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let routes = serde_json::json!([{"model":"rank-route","protocol":"cohere-rerank","fallback":true,"targets":[
        {"url":format!("http://{addr}/first/rerank"),"model":"rerank-v3.5","api_key_env":"PROVIDER"},
        {"url":format!("http://{addr}/v2/rerank"),"model":"rerank-v3.5","api_key_env":"PROVIDER"}
    ]}])
    .to_string();
    let policies = r#"[
        {"api_key_env":"FIRST","allowed_endpoints":["rerank"],"allowed_models":["rerank-v3.5"],"max_requests_per_minute":1},
        {"api_key_env":"SECOND","allowed_endpoints":["rerank"],"max_requests_per_day":1},
        {"api_key_env":"CHAT","allowed_endpoints":["chat"]}
    ]"#;
    let state = ProxyState::new(
        &format!("http://{addr}/v1/chat/completions"),
        "default-client-key-123",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(&routes, |_| Some("cohere-provider-secret".into()), false)
    .await
    .unwrap()
    .with_client_policies(policies, |name| match name {
        "FIRST" => Some("first-client-key-123".into()),
        "SECOND" => Some("second-client-key-123".into()),
        "CHAT" => Some("chat-client-key-12345".into()),
        _ => None,
    })
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = |key: &str| {
        client.post(format!("{base}/v1/rerank")).bearer_auth(key)
        .body(r#"{"model":"rank-route","query":"needle","documents":["first","second"],"top_n":1}"#).send()
    };
    assert_eq!(
        send("chat-client-key-12345").await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        client
            .post(format!("{base}/v1/rerank"))
            .bearer_auth("first-client-key-123")
            .body(r#"{"model":"unknown-route","query":"needle","documents":["first"]}"#)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let response = send("first-client-key-123").await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(body["results"][0]["index"], 1);
    assert_eq!(
        send("first-client-key-123").await.unwrap().status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        send("second-client-key-123").await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(
        send("second-client-key-123").await.unwrap().status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(failures.load(Ordering::SeqCst), 2);
    task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn embeddings_routes_enforce_endpoint_and_model_policies() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let provider = Router::new().route(
        "/v1/embeddings",
        post(move |headers: HeaderMap, body: String| {
            let observed = observed.clone();
            async move {
                observed.fetch_add(1, Ordering::SeqCst);
                assert_eq!(
                    headers[header::AUTHORIZATION],
                    "Bearer embedding-provider-secret"
                );
                let body: serde_json::Value = serde_json::from_str(&body).unwrap();
                assert_eq!(body["model"], "vendor/embedding-model");
                assert_eq!(body["input"], serde_json::json!(["one", "two"]));
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    r#"{"data":[{"embedding":[0.5]}]}"#,
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let routes = serde_json::json!([{"model":"vector-route","protocol":"openai-embeddings","targets":[{
        "url":format!("http://{addr}/v1/embeddings"),"model":"vendor/embedding-model","api_key_env":"PROVIDER"
    }]}]).to_string();
    let policies = r#"[
        {"api_key_env":"VECTOR","allowed_endpoints":["embeddings"],"allowed_models":["vendor/*"],"expires_at_unix":4102444800},
        {"api_key_env":"CHAT","allowed_endpoints":["chat"]},
        {"api_key_env":"BLOCKED","allowed_endpoints":["embeddings"],"blocked_models":["vendor/*"]},
        {"api_key_env":"EXPIRED","expires_at_unix":0}
    ]"#;
    let state = ProxyState::new(
        &format!("http://{addr}/v1/chat/completions"),
        "default-client-key-123",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(&routes, |_| Some("embedding-provider-secret".into()), false)
    .await
    .unwrap()
    .with_client_policies(policies, |name| match name {
        "VECTOR" => Some("vector-client-key-123".into()),
        "CHAT" => Some("chat-client-key-12345".into()),
        "BLOCKED" => Some("blocked-client-key-123".into()),
        "EXPIRED" => Some("expired-client-key-123".into()),
        _ => None,
    })
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let proxy_task =
        tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = |path: &str, key: &str| {
        client
            .post(format!("{base}{path}"))
            .bearer_auth(key)
            .header(header::CONTENT_TYPE, "application/json")
            .body(serde_json::json!({"model":"vector-route","input":["one","two"]}).to_string())
            .send()
    };
    assert_eq!(
        send("/v1/embeddings", "expired-client-key-123")
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send("/v1/embeddings", "chat-client-key-12345")
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send("/v1/embeddings", "blocked-client-key-123")
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send("/v1/chat/completions", "vector-client-key-123")
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let response = send("/v1/embeddings", "vector-client-key-123")
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response: serde_json::Value =
        serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(response["data"][0]["embedding"], serde_json::json!([0.5]));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    proxy_task.abort();
    provider_task.abort();
}

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
        serde_json::json!([{"model":"a", "targets":[{"url":"http://127.0.0.1:12345/v1/chat/completions", "model":"model", "api_key_env":"PROVIDER_KEY", "auth":"bearer"}]}]),
        serde_json::json!([{"model":"a", "protocol":"anthropic", "targets":[{"url":"http://127.0.0.1:12345/v1/messages", "model":"model", "api_key_env":"PROVIDER_KEY", "auth":"unknown"}]}]),
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
        {"api_key_env":"CLIENT_DISABLED","enabled":false},
        {"api_key_env":"CLIENT_ALLOW","allowed_models":["vendor/allowed"]},
        {"api_key_env":"CLIENT_DENY","allowed_models":[]},
        {"api_key_env":"CLIENT_ENDPOINT","allowed_endpoints":["images"]},
        {"api_key_env":"CLIENT_EMPTY_ENDPOINTS","allowed_endpoints":[],"allowed_models":["vendor/allowed"]}
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
            "CLIENT_ALLOW" => Some("client-allow-key-123".into()),
            "CLIENT_DENY" => Some("client-deny-key-1234".into()),
            "CLIENT_ENDPOINT" => Some("client-nochat-key-123".into()),
            "CLIENT_EMPTY_ENDPOINTS" => Some("client-empty-key-123".into()),
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
    let response = send("client-allow-key-123", "combo").await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "allowed");
    assert_eq!(
        send("client-deny-key-1234", "combo")
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send("client-nochat-key-123", "combo")
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let response = send("client-empty-key-123", "combo").await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "allowed");
    assert_eq!(calls.load(Ordering::SeqCst), 3);
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
        serde_json::json!([{"api_key_env":"KEY","allowed_models":"all"}]),
        serde_json::json!([{"api_key_env":"KEY","allowed_endpoints":"chat"}]),
        serde_json::json!([{"api_key_env":"KEY","allowed_endpoints":[""]}]),
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
#[ignore = "run explicitly in release mode for descriptive performance"]
async fn benchmark_mixed_combo() {
    let provider = Router::new()
        .route(
            "/v1/chat/completions",
            post(|body: String| async move {
                let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                if value["model"] == "gpt-fail" {
                    (StatusCode::TOO_MANY_REQUESTS, "busy").into_response()
                } else {
                    axum::Json(serde_json::json!({"choices":[{"message":{"content":"ok"}}]}))
                        .into_response()
                }
            }),
        )
        .route(
            "/v1/messages",
            post(|| async {
                axum::Json(serde_json::json!({"id":"msg_1","model":"claude-model",
                "content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn",
                "usage":{"input_tokens":3,"output_tokens":1}}))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let make_route = |name, model| {
        serde_json::json!({"model":name,"fallback":true,"targets":[
            {"url":format!("http://{addr}/v1/chat/completions"),"model":model,"api_key_env":"OPENAI"},
            {"url":format!("http://{addr}/v1/messages"),"model":"claude-model","api_key_env":"ANTHROPIC","protocol":"openai-to-anthropic"}
        ]})
    };
    let routes = serde_json::json!([
        make_route("primary", "gpt-ok"),
        make_route("fallback", "gpt-fail")
    ])
    .to_string();
    let state = ProxyState::new(
        &format!("http://{addr}/v1/chat/completions"),
        "client-key-12345678",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(&routes, |_| Some("upstream-key".into()), false)
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = listener.local_addr().unwrap();
    let proxy_task =
        tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for route in ["primary", "fallback"] {
        let samples: Vec<u128> = stream::iter(0..220).map(|_| {
            let client = client.clone();
            async move {
                let start = std::time::Instant::now();
                let response = client.post(format!("http://{proxy}/v1/chat/completions"))
                    .bearer_auth("client-key-12345678")
                    .body(serde_json::json!({"model":route,"messages":[{"role":"user","content":"hello"}]}).to_string())
                    .send().await.unwrap();
                assert_eq!(response.status(),StatusCode::OK);
                response.bytes().await.unwrap();
                start.elapsed().as_micros()
            }
        }).buffered(16).collect().await;
        let mut measured = samples[20..].to_vec();
        measured.sort_unstable();
        println!(
            "mixed-{route}: n={} concurrency=16 p50={}us p95={}us",
            measured.len(),
            measured[measured.len() / 2],
            measured[measured.len() * 95 / 100]
        );
    }
    proxy_task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn mixed_provider_combo_translates_only_the_anthropic_attempt() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    let fail_primary = Arc::new(AtomicBool::new(false));
    let calls = Arc::new([AtomicUsize::new(0), AtomicUsize::new(0)]);
    let first_fail = fail_primary.clone();
    let first_calls = calls.clone();
    let second_calls = calls.clone();
    let provider = Router::new()
        .route("/v1/chat/completions", post(move |headers: HeaderMap, body: String| {
            let fail = first_fail.clone();
            let calls = first_calls.clone();
            async move {
                calls[0].fetch_add(1, Ordering::SeqCst);
                assert_eq!(headers[header::AUTHORIZATION], "Bearer openai-key");
                let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                assert_eq!(value["model"], "gpt-model");
                if fail.load(Ordering::SeqCst) {
                    return (StatusCode::TOO_MANY_REQUESTS, "busy").into_response();
                }
                (StatusCode::OK, axum::Json(serde_json::json!({"provider":"openai"}))).into_response()
            }
        }))
        .route("/v1/messages", post(move |headers: HeaderMap, body: String| {
            let calls = second_calls.clone();
            async move {
                calls[1].fetch_add(1, Ordering::SeqCst);
                assert_eq!(headers["x-api-key"], "anthropic-key");
                assert_eq!(headers["anthropic-version"], "2023-06-01");
                let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                assert_eq!(value["model"], "claude-model");
                if value["stream"] == true {
                    return ([(header::CONTENT_TYPE, "text/event-stream")], concat!(
                        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-model\",\"usage\":{\"input_tokens\":3}}}\n\n",
                        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"fallback\"}}\n\n",
                        "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n",
                        "data: {\"type\":\"message_stop\"}\n\n"
                    )).into_response();
                }
                axum::Json(serde_json::json!({"id":"msg_1","model":"claude-model",
                    "content":[{"type":"text","text":"fallback"}],"stop_reason":"end_turn",
                    "usage":{"input_tokens":3,"output_tokens":1}})).into_response()
            }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let routes = serde_json::json!([{"model":"mixed","fallback":true,"targets":[
        {"url":format!("http://{addr}/v1/chat/completions"),"model":"gpt-model","api_key_env":"OPENAI"},
        {"url":format!("http://{addr}/v1/messages"),"model":"claude-model","api_key_env":"ANTHROPIC","protocol":"openai-to-anthropic"}
    ]}]).to_string();
    let state = ProxyState::new(
        &format!("http://{addr}/v1/chat/completions"),
        "client-key-12345678",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(
        &routes,
        |name| match name {
            "OPENAI" => Some("openai-key".into()),
            "ANTHROPIC" => Some("anthropic-key".into()),
            _ => None,
        },
        false,
    )
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = listener.local_addr().unwrap();
    let proxy_task =
        tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = |body: serde_json::Value| {
        client
            .post(format!("http://{proxy}/v1/chat/completions"))
            .bearer_auth("client-key-12345678")
            .body(body.to_string())
            .send()
    };
    let body = serde_json::json!({"model":"mixed","messages":[{"role":"user","content":"hello"}]});
    let first: serde_json::Value =
        serde_json::from_str(&send(body.clone()).await.unwrap().text().await.unwrap()).unwrap();
    assert_eq!(first["provider"], "openai");
    fail_primary.store(true, Ordering::SeqCst);
    let fallback: serde_json::Value =
        serde_json::from_str(&send(body.clone()).await.unwrap().text().await.unwrap()).unwrap();
    assert_eq!(fallback["choices"][0]["message"]["content"], "fallback");
    let mut streaming = body.clone();
    streaming["stream"] = true.into();
    let stream = send(streaming).await.unwrap().text().await.unwrap();
    assert!(stream.contains("fallback"));
    assert!(stream.contains("[DONE]"));
    let before = calls[0].load(Ordering::SeqCst);
    let mut unsupported = body;
    unsupported["modalities"] = serde_json::json!(["audio"]);
    assert_eq!(
        send(unsupported).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(calls[0].load(Ordering::SeqCst), before);
    assert_eq!(calls[1].load(Ordering::SeqCst), 2);
    proxy_task.abort();
    provider_task.abort();
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

#[tokio::test]
async fn gemini_native_routes_preserve_bodies_streams_and_credentials() {
    use axum::extract::{Path, Request};
    use std::sync::atomic::{AtomicUsize, Ordering};

    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let provider = Router::new().route(
        "/v1beta/models/{model_action}",
        post(move |Path(action): Path<String>, request: Request| {
            let seen = seen.clone();
            async move {
                seen.fetch_add(1, Ordering::SeqCst);
                assert_eq!(
                    request.headers().get("x-goog-api-key").unwrap(),
                    "gemini-provider-key"
                );
                assert!(request.headers().get(header::AUTHORIZATION).is_none());
                let query = request.uri().query().map(str::to_owned);
                let body = axum::body::to_bytes(request.into_body(), 1024)
                    .await
                    .unwrap();
                let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["contents"][0]["parts"][0]["text"], "hello");
                assert!(body.get("model").is_none());
                match action.as_str() {
                    "provider-model:generateContent" => {
                        assert_eq!(query, None);
                        (
                            [(header::CONTENT_TYPE, "application/json")],
                            "{\"ok\":true}",
                        )
                    }
                    "provider-model:streamGenerateContent" => {
                        assert_eq!(query.as_deref(), Some("alt=sse"));
                        (
                            [(header::CONTENT_TYPE, "text/event-stream")],
                            "data: {\"ok\":true}\n\n",
                        )
                    }
                    _ => panic!("unexpected provider path"),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let config = serde_json::json!([{"model":"gemini-route", "protocol":"gemini", "targets":[{
        "url":format!("http://{addr}/v1beta/models"), "model":"provider-model", "api_key_env":"GEMINI_KEY"
    }]}]).to_string();
    let state = ProxyState::new(
        &format!("http://{addr}/v1/chat/completions"),
        "client-key-12345678",
        "unused",
        false,
    )
    .await
    .unwrap()
    .with_routes(&config, |_| Some("gemini-provider-key".into()), false)
    .await
    .unwrap()
    .with_client_policies(
        r#"[{"api_key_env":"CLIENT","allowed_routes":["gemini-route"]}]"#,
        |_| Some("client-key-12345678".into()),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let proxy_task =
        tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let body = r#"{"contents":[{"parts":[{"text":"hello"}]}]}"#;
    let path = "/v1beta/models/gemini-route:generateContent";
    assert_eq!(
        client
            .post(format!("{base}{path}"))
            .header("x-goog-api-key", "client-key-12345678")
            .bearer_auth("client-key-12345678")
            .body(body)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(format!("{base}{path}?key=secret"))
            .header("x-goog-api-key", "client-key-12345678")
            .body(body)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .post(format!("{base}/v1beta/models/unknown:generateContent"))
            .header("x-goog-api-key", "client-key-12345678")
            .body(body)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth("client-key-12345678")
            .body(r#"{"model":"gemini-route"}"#)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .post(format!("{base}{path}"))
            .header("x-goog-api-key", "client-key-12345678")
            .body(r#"{"model":"other","contents":[]}"#)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let response = client
        .post(format!("{base}{path}"))
        .header("x-goog-api-key", "client-key-12345678")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "{\"ok\":true}");
    let response = client
        .post(format!(
            "{base}/v1beta/models/gemini-route:streamGenerateContent?alt=sse"
        ))
        .bearer_auth("client-key-12345678")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/event-stream"
    );
    assert_eq!(response.text().await.unwrap(), "data: {\"ok\":true}\n\n");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    proxy_task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn allowed_models_also_applies_without_configured_routes() {
    let state = ProxyState::new(
        "http://127.0.0.1:12345/v1/chat/completions",
        "default-client-key-123",
        "provider",
        false,
    )
    .await
    .unwrap()
    .with_client_policies(
        r#"[{"api_key_env":"CLIENT","allowed_models":["vendor/allowed"]}]"#,
        |_| Some("client-key-12345678".into()),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let task = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(url)
        .bearer_auth("client-key-12345678")
        .body(r#"{"model":"vendor/not-allowed"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    task.abort();
}
