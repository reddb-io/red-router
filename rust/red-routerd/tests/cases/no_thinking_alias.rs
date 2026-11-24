#[tokio::test]
async fn a_no_thinking_alias_reaches_the_real_model_without_reasoning() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("no-think.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (upstream_url, bodies, upstream_task) = captured_provider("nothink-secret", "ok").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (path, body) in [
        (
            "providers/nothink-account",
            serde_json::json!({
                "provider":"openai-compatible",
                "upstream_url":upstream_url,
                "api_key":"nothink-secret"
            }),
        ),
        (
            "combos/nothink-combo",
            serde_json::json!({
                "strategy":"priority",
                "fallback":true,
                "targets":[{"provider_id":"nothink-account","model":"upstream-model"}]
            }),
        ),
        (
            "client-keys/nothink-client",
            serde_json::json!({
                "label":"No-think client",
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
    assert_eq!(
        client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth(RUST_CLIENT_KEY)
            .json(&serde_json::json!({
                "model":"no-think/nothink-combo",
                "reasoning_effort":"high",
                "messages":[{"role":"user","content":"hi"}]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let bodies = bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0]["model"], "upstream-model");
    assert_eq!(bodies[0]["reasoning_effort"], "none");

    gateway_task.abort();
    upstream_task.abort();
}
