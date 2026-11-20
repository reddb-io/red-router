#[tokio::test]
async fn round_robin_combos_send_sticky_batches() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("combo-sticky.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let control = ControlPlane::new(
        Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap()),
        ADMIN_KEY,
        STORAGE_KEY,
        true,
    )
    .await
    .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (a_url, a_task) = provider("sticky-a-secret", "a").await;
    let (b_url, b_task) = provider("sticky-b-secret", "b").await;
    for (id, upstream, credential) in [
        ("sticky-a", &a_url, "sticky-a-secret"),
        ("sticky-b", &b_url, "sticky-b-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"openai",
                    "upstream_url":upstream,
                    "api_key":credential
                }))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/sticky-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Sticky client",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["sticky-combo","upstream-model"],
                "allowed_provider_ids":["sticky-a","sticky-b"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/sticky-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"round-robin",
                "fallback":true,
                "targets":[
                    {"provider_id":"sticky-a","model":"upstream-model"},
                    {"provider_id":"sticky-b","model":"upstream-model"}
                ]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let picks = |count: usize| {
        let client = client.clone();
        let base = base.clone();
        async move {
            let mut picks = Vec::new();
            for _ in 0..count {
                let response = chat_model(&client, &base, RUST_CLIENT_KEY, "sticky-combo").await;
                assert_eq!(response.status(), StatusCode::OK);
                picks.push(response.text().await.unwrap());
            }
            picks
        }
    };
    let limit = |value: u32| {
        client
            .put(format!(
                "{base}/api/admin/global-settings/combo_sticky_round_robin_limit"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!(value))
            .send()
    };
    // The legacy default batch is the provider pools' limit of three.
    assert_eq!(picks(7).await, ["a", "a", "a", "b", "b", "b", "a"]);
    assert_eq!(limit(2).await.unwrap().status(), StatusCode::OK);
    // A settings change recompiles the routes, which starts the rotation
    // over (the legacy state, keyed by combo name, would survive it).
    assert_eq!(picks(5).await, ["a", "a", "b", "b", "a"]);
    // A limit of one rotates on every request.
    assert_eq!(limit(1).await.unwrap().status(), StatusCode::OK);
    assert_eq!(picks(3).await, ["a", "b", "a"]);
    assert_eq!(limit(0).await.unwrap().status(), StatusCode::BAD_REQUEST);

    gateway_task.abort();
    a_task.abort();
    b_task.abort();
}
