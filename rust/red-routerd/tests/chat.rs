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
