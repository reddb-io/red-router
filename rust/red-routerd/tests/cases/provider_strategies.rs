#[tokio::test]
async fn provider_pools_rotate_accounts_with_the_configured_strategy() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("provider-strategies.sqlite")).unwrap();
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
    let (first_url, first_seen, first_task) =
        alias_test_provider("rotate-first", StatusCode::OK).await;
    let (second_url, second_seen, second_task) =
        alias_test_provider("rotate-second", StatusCode::OK).await;
    for (id, upstream, credential, priority) in [
        ("rotate-first", &first_url, "rotate-first", 1),
        ("rotate-second", &second_url, "rotate-second", 2),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"rotate-api",
                    "upstream_url":upstream,
                    "api_key":credential,
                    "priority":priority
                }))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    let key = "rotate-client-key-1234567890123456789";
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/rotate-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Rotate client",
                "api_key":key,
                "scopes":["inference:chat"],
                "allowed_models":["rotate-api/model-1"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let counts = || {
        (
            first_seen.lock().unwrap().len(),
            second_seen.lock().unwrap().len(),
        )
    };
    // Fill-first by default: the priority account takes every request.
    for _ in 0..2 {
        assert_eq!(
            chat_model(&client, &base, key, "rotate-api/model-1")
                .await
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(counts(), (2, 0));

    // Sticky round-robin with a limit of two.
    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/global-settings/provider_strategies"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "providers":{"rotate-api":{"strategy":"round-robin","sticky_round_robin_limit":2}}
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let mut picks = Vec::new();
    for _ in 0..6 {
        let before = counts();
        assert_eq!(
            chat_model(&client, &base, key, "rotate-api/model-1")
                .await
                .status(),
            StatusCode::OK
        );
        let after = counts();
        picks.push(if after.0 > before.0 {
            "first"
        } else {
            "second"
        });
    }
    assert_eq!(
        picks,
        ["first", "first", "second", "second", "first", "first"]
    );
    // An unsupported legacy strategy is refused.
    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/global-settings/provider_strategies"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"default":{"strategy":"p2c"}}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );

    gateway_task.abort();
    first_task.abort();
    second_task.abort();
}
