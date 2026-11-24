// Ported from the legacy chatCore normalizeAttemptBody guards
// (tests/unit/combo-thinking-disabled-fable5-3554.test.ts and
// claude-adaptive-thinking-normalize.test.ts): the body a routed target
// receives is normalized for the model actually called, so a substituted
// model never receives thinking or tool-choice values it rejects.
#[tokio::test]
async fn routed_bodies_are_normalized_for_the_model_actually_called() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("spec-guards.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let bodies = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let observed = bodies.clone();
    let app = Router::new()
        .route(
            "/v1/messages",
            post({
                let observed = observed.clone();
                move |Json(body): Json<serde_json::Value>| {
                    let observed = observed.clone();
                    async move {
                        observed.lock().unwrap().push(body);
                        Json(serde_json::json!({
                            "id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-8",
                            "content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn",
                            "usage":{"input_tokens":1,"output_tokens":1}
                        }))
                    }
                }
            }),
        )
        .route(
            "/v1/chat/completions",
            post(move |Json(body): Json<serde_json::Value>| {
                let observed = observed.clone();
                async move {
                    observed.lock().unwrap().push(body);
                    "chat-ok"
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (id, provider, path) in [
        ("guards-claude", "anthropic", "/v1/messages"),
        ("guards-openai", "openai-compatible", "/v1/chat/completions"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":provider,
                    "upstream_url":format!("http://{address}{path}"),
                    "api_key":"guards-provider-secret"
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
            "guards-messages",
            serde_json::json!({"protocol":"anthropic","strategy":"priority","targets":[{"provider_id":"guards-claude","model":"claude-opus-4-8"}]}),
        ),
        (
            "guards-chat",
            serde_json::json!({"strategy":"priority","targets":[{"provider_id":"guards-openai","model":"claude-opus-5-5"}]}),
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
            .put(format!("{base}/api/admin/client-keys/guards-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"label":"Guards", "api_key":RUST_CLIENT_KEY, "enabled":true}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    // Opus 4.8 is adaptive-only: manual thinking becomes adaptive.
    let messages = client
        .post(format!("{base}/v1/messages"))
        .bearer_auth(RUST_CLIENT_KEY)
        .json(&serde_json::json!({
            "model":"guards-messages",
            "max_tokens":64,
            "thinking":{"type":"enabled","budget_tokens":32000},
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(messages.status(), StatusCode::OK);
    // Opus 5.5 rejects disabled thinking and forced tool choices.
    let chat = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(RUST_CLIENT_KEY)
        .json(&serde_json::json!({
            "model":"guards-chat",
            "thinking":{"type":"disabled"},
            "tool_choice":"required",
            "tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}],
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(chat.status(), StatusCode::OK);
    assert_eq!(chat.text().await.unwrap(), "chat-ok");

    let bodies = bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 2, "{bodies:?}");
    assert_eq!(bodies[0]["model"], "claude-opus-4-8");
    assert_eq!(
        bodies[0]["thinking"],
        serde_json::json!({"type":"adaptive"})
    );
    assert_eq!(bodies[1]["model"], "claude-opus-5-5");
    assert!(bodies[1].get("thinking").is_none(), "{}", bodies[1]);
    assert!(bodies[1].get("tool_choice").is_none(), "{}", bodies[1]);
    assert_eq!(bodies[1]["tools"][0]["function"]["name"], "lookup");

    gateway_task.abort();
    upstream_task.abort();
}
