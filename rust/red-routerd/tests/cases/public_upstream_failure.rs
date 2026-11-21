// Ported from the legacy chatCore failure return (createErrorResult over
// parseUpstreamError, tests/unit/error-sensitive-redaction.test.ts and the
// upstreamErrorPassthrough contract): a failed provider answer reaches the
// client as the sanitized public envelope, and a Claude-format client keeps
// an eligible 4xx shape.
#[tokio::test]
async fn provider_failures_reach_clients_as_the_sanitized_public_envelope() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("public-failure.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    const CHAT_FAILURE: &str = r#"{"error":{"message":"Invalid key sk-abcdefghijklmnop for /srv/omniroute/src/private/provider.ts:42:7","type":"invalid_request_error","code":"invalid_api_key"}}"#;
    const CLAUDE_FAILURE: &str = r#"{"type":"error","error":{"type":"invalid_request_error","message":"thinking: not supported for this model"}}"#;
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(|| async {
                (
                    StatusCode::BAD_REQUEST,
                    [(header::CONTENT_TYPE, "application/json")],
                    CHAT_FAILURE,
                )
            }),
        )
        .route(
            "/v1/messages",
            post(|| async {
                (
                    StatusCode::BAD_REQUEST,
                    [(header::CONTENT_TYPE, "application/json")],
                    CLAUDE_FAILURE,
                )
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (id, provider, path) in [
        (
            "failure-openai",
            "openai-compatible",
            "/v1/chat/completions",
        ),
        ("failure-claude", "anthropic", "/v1/messages"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":provider,
                    "upstream_url":format!("http://{address}{path}"),
                    "api_key":"failure-provider-secret"
                }))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    for (combo, body) in [
        (
            "failure-chat",
            serde_json::json!({"strategy":"priority","targets":[{"provider_id":"failure-openai","model":"failing-model"}]}),
        ),
        (
            "failure-messages",
            serde_json::json!({"protocol":"anthropic","strategy":"priority","targets":[{"provider_id":"failure-claude","model":"claude-failing"}]}),
        ),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/combos/{combo}"))
                .bearer_auth(ADMIN_KEY)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/failure-client"))
            .bearer_auth(ADMIN_KEY)
            .json(
                &serde_json::json!({"label":"Failure", "api_key":RUST_CLIENT_KEY, "enabled":true})
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let chat = chat_model(&client, &base, RUST_CLIENT_KEY, "failure-chat").await;
    assert_eq!(chat.status(), StatusCode::BAD_REQUEST);
    let chat: serde_json::Value = chat.json().await.unwrap();
    let text = chat.to_string();
    assert!(!text.contains("sk-abcdefghijklmnop"), "{text}");
    assert!(!text.contains("/srv/omniroute"), "{text}");
    assert!(
        chat["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("[400]: Invalid key [REDACTED]"),
        "{text}"
    );
    assert_eq!(chat["error"]["type"], "invalid_request_error");
    assert_eq!(chat["error"]["code"], "invalid_api_key");
    assert_eq!(chat["upstream_details"]["error"]["code"], "invalid_api_key");
    let upstream = red_routerd::public_error::parse_upstream_error(400, CHAT_FAILURE, "");
    assert_eq!(
        chat,
        red_routerd::public_error::upstream_failure(400, &upstream, None, false).body
    );

    let messages = client
        .post(format!("{base}/v1/messages"))
        .bearer_auth(RUST_CLIENT_KEY)
        .json(&serde_json::json!({
            "model":"failure-messages",
            "max_tokens":8,
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(messages.status(), StatusCode::BAD_REQUEST);
    let messages: serde_json::Value = messages.json().await.unwrap();
    assert_eq!(
        messages,
        serde_json::from_str::<serde_json::Value>(CLAUDE_FAILURE).unwrap()
    );

    gateway_task.abort();
    upstream_task.abort();
}
