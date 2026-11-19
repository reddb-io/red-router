#[tokio::test]
async fn the_custom_system_prompt_reaches_chat_requests_when_enabled() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("system-prompt.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (upstream_url, bodies, upstream_task) = captured_provider("prompt-secret", "ok").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (path, body) in [
        (
            "providers/prompt-account",
            serde_json::json!({
                "provider":"openai-compatible",
                "upstream_url":upstream_url,
                "api_key":"prompt-secret"
            }),
        ),
        (
            "combos/prompt-combo",
            serde_json::json!({
                "strategy":"priority",
                "fallback":true,
                "targets":[{"provider_id":"prompt-account","model":"upstream-model"}]
            }),
        ),
        (
            "client-keys/prompt-client",
            serde_json::json!({
                "label":"Prompt client",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"]
            }),
        ),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/{path}"))
                .bearer_auth(ADMIN_KEY)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
            "{path}"
        );
    }
    let endpoint = format!("{base}/api/admin/global-settings/custom_system_prompt");
    assert_eq!(
        client
            .put(&endpoint)
            .json(&serde_json::json!({"enabled":true,"prompt":"Be terse."}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .put(&endpoint)
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"enabled":true,"unknown":1}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/global-settings/not_a_setting"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!(true))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let chat = |content: &'static str| {
        let (client, base) = (client.clone(), base.clone());
        async move {
            assert_eq!(
                client
                    .post(format!("{base}/v1/chat/completions"))
                    .bearer_auth(RUST_CLIENT_KEY)
                    .json(&serde_json::json!({
                        "model":"prompt-combo",
                        "messages":[{"role":"user","content":content}]
                    }))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
        }
    };

    chat("before").await;
    assert_eq!(
        client
            .put(&endpoint)
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"enabled":true,"prompt":"Be terse."}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    chat("during").await;
    // The setting survives a restart.
    gateway_task.abort();
    let restarted = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    let listed: serde_json::Value = client
        .get(format!("{restarted_base}/api/admin/global-settings"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        listed["global_settings"]["custom_system_prompt"],
        serde_json::json!({"enabled":true,"prompt":"Be terse."})
    );

    let bodies = bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 2);
    assert_eq!(
        bodies[0]["messages"],
        serde_json::json!([{"role":"user","content":"before"}])
    );
    assert_eq!(
        bodies[1]["messages"],
        serde_json::json!([
            {"role":"system","content":"Be terse."},
            {"role":"user","content":"during"}
        ])
    );

    // A configured body limit applies to routes without the LLM floor
    // (Messages; Chat Completions and Responses keep at least 50 MiB).
    assert_eq!(
        client
            .put(format!(
                "{restarted_base}/api/admin/global-settings/max_body_size_mb"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!(1))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let large = serde_json::json!({
        "model":"prompt-combo",
        "max_tokens":1,
        "messages":[{"role":"user","content":"x".repeat(1_500_000)}]
    })
    .to_string();
    assert_eq!(
        client
            .post(format!("{restarted_base}/v1/messages"))
            .header("anthropic-version", "2023-06-01")
            .bearer_auth(RUST_CLIENT_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(large)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );

    restarted_task.abort();
    upstream_task.abort();
}
