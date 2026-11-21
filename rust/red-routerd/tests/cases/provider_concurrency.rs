#[tokio::test]
async fn an_account_at_its_concurrency_cap_is_skipped_before_dispatch() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("concurrency.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    // The capped account holds its first request until the test releases it.
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let (busy_entered, busy_release) = (entered.clone(), release.clone());
    let busy_app = Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let (entered, release) = (busy_entered.clone(), busy_release.clone());
            async move {
                entered.notify_one();
                release.notified().await;
                "busy"
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let busy_url = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let busy_task = tokio::spawn(async move { axum::serve(listener, busy_app).await.unwrap() });
    let (spare_url, spare_task) = provider("spare-secret", "spare").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    for (id, upstream_url, api_key, cap) in [
        ("busy", busy_url, "busy-secret", serde_json::json!(1)),
        (
            "spare",
            spare_url.clone(),
            "spare-secret",
            serde_json::Value::Null,
        ),
    ] {
        let response = client
            .put(format!("{base}/api/admin/providers/{id}"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"openai-compatible",
                "upstream_url":upstream_url,
                "api_key":api_key,
                "max_concurrent":cap
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let view: serde_json::Value = response.json().await.unwrap();
        assert_eq!(view["provider"]["max_concurrent"], cap, "{id}");
    }
    // An out-of-range cap is refused.
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/spare"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"openai-compatible",
                "upstream_url":spare_url,
                "api_key":"spare-secret",
                "max_concurrent":0
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/concurrency-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Concurrency client",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["capped-combo","upstream-model"],
                "allowed_provider_ids":["busy","spare"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/capped-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"priority",
                "fallback":true,
                "targets":[
                    {"provider_id":"busy","model":"upstream-model"},
                    {"provider_id":"spare","model":"upstream-model"}
                ]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let first = {
        let (client, base) = (client.clone(), base.clone());
        tokio::spawn(async move {
            chat_model(&client, &base, RUST_CLIENT_KEY, "capped-combo")
                .await
                .text()
                .await
                .unwrap()
        })
    };
    entered.notified().await;
    // The priority account is at its cap of one, so routing falls through.
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "capped-combo")
            .await
            .text()
            .await
            .unwrap(),
        "spare"
    );
    release.notify_one();
    assert_eq!(first.await.unwrap(), "busy");

    gateway_task.abort();
    busy_task.abort();
    spare_task.abort();
}
