// An opencode-go account serves its Anthropic Messages models at /messages with
// an x-api-key (legacy OpencodeExecutor), and its chat models at chat completions.
#[tokio::test]
async fn opencode_go_messages_model_is_sent_to_the_messages_endpoint() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("go.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let seen = Arc::new(Mutex::new(
        Vec::<(String, Option<String>, serde_json::Value)>::new(),
    ));
    let observed = seen.clone();
    let record = |path: &'static str| {
        let observed = observed.clone();
        post(move |headers: HeaderMap, body: String| {
            let observed = observed.clone();
            async move {
                observed.lock().unwrap().push((
                    path.to_owned(),
                    headers
                        .get("x-api-key")
                        .map(|value| value.to_str().unwrap().to_owned()),
                    serde_json::from_str(&body).unwrap(),
                ));
                Json(serde_json::json!({
                    "id":"msg_go","type":"message","role":"assistant","model":"minimax-m3",
                    "content":[{"type":"text","text":"from messages"}],
                    "stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}
                }))
            }
        })
    };
    let app = Router::new()
        .route("/zen/go/v1/messages", record("messages"))
        .route("/zen/go/v1/chat/completions", record("chat"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/go"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "provider":"opencode-go",
                    "upstream_url":format!("http://{address}/zen/go/v1/chat/completions"),
                    "api_key":"go-secret"
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/go-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Go client","api_key":RUST_CLIENT_KEY,
                    "scopes":["inference:chat"],"allowed_endpoints":["chat"],
                    "allowed_models":["opencode-go/minimax-m3"],
                    "allowed_provider_ids":["go"]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let response = chat_model_with_body(
        &client,
        &base,
        RUST_CLIENT_KEY,
        serde_json::json!({"model":"opencode-go/minimax-m3","messages":[{"role":"user","content":"hi"}]}),
    )
    .await;
    let status = response.status();
    let text = response.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{text}");
    assert!(text.contains("from messages"), "{text}");
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, "messages");
    assert_eq!(seen[0].1.as_deref(), Some("go-secret"));
    assert_eq!(seen[0].2["model"], "minimax-m3");
    gateway_task.abort();
    provider_task.abort();
    database.close().await.unwrap();
}

// An opencode-go Responses model is sent a streamed Responses request at
// /responses with the Bearer key, and the answer is translated back to chat,
// folded into one object or streamed.
#[tokio::test]
async fn opencode_go_responses_model_is_translated_both_ways() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("go-responses.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let seen = Arc::new(Mutex::new(Vec::<(Option<String>, serde_json::Value)>::new()));
    let observed = seen.clone();
    let app = Router::new().route(
        "/zen/go/v1/responses",
        post(move |headers: HeaderMap, body: String| {
            let observed = observed.clone();
            async move {
                observed.lock().unwrap().push((
                    headers
                        .get(header::AUTHORIZATION)
                        .map(|value| value.to_str().unwrap().to_owned()),
                    serde_json::from_str(&body).unwrap(),
                ));
                let events = [
                    serde_json::json!({"type":"response.created","response":{"model":"grok-4.7"}}),
                    serde_json::json!({"type":"response.output_text.delta","delta":"from "}),
                    serde_json::json!({"type":"response.output_text.delta","delta":"responses"}),
                    serde_json::json!({"type":"response.completed","response":{"model":"grok-4.7","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}),
                ];
                (
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    events
                        .iter()
                        .map(|event| format!("data: {event}\n\n"))
                        .collect::<String>(),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/go"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "provider":"opencode-go",
                    "upstream_url":format!("http://{address}/zen/go/v1/chat/completions"),
                    "api_key":"go-secret"
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/go-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Go client","api_key":RUST_CLIENT_KEY,
                    "scopes":["inference:chat"],"allowed_endpoints":["chat"],
                    "allowed_models":["opencode-go/grok-4.7"],
                    "allowed_provider_ids":["go"]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let request = |stream: bool| {
        serde_json::json!({
            "model":"opencode-go/grok-4.7","stream":stream,
            "messages":[{"role":"user","content":"hi"}]
        })
    };
    let folded = chat_model_with_body(&client, &base, RUST_CLIENT_KEY, request(false)).await;
    let status = folded.status();
    let text = folded.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{text}");
    let folded: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        folded["choices"][0]["message"]["content"], "from responses",
        "{text}"
    );
    assert_eq!(folded["usage"]["prompt_tokens"], 4);

    let streamed = chat_model_with_body(&client, &base, RUST_CLIENT_KEY, request(true)).await;
    assert_eq!(streamed.status(), StatusCode::OK);
    let text = streamed.text().await.unwrap();
    assert!(
        text.contains("\"from \"") && text.contains("\"responses\""),
        "{text}"
    );
    assert!(text.trim_end().ends_with("data: [DONE]"), "{text}");

    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    for (authorization, body) in &seen {
        assert_eq!(authorization.as_deref(), Some("Bearer go-secret"));
        assert_eq!(body["model"], "grok-4.7");
        assert_eq!(body["stream"], true);
        assert!(body.get("input").is_some(), "{body}");
    }
    gateway_task.abort();
    provider_task.abort();
    database.close().await.unwrap();
}
