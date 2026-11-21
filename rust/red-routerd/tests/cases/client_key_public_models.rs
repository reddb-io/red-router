#[tokio::test]
async fn public_models_only_keys_reach_published_models_and_granted_combos() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("public-models.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (upstream_url, upstream_task) = provider("public-secret", "ok").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/public-account"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"openai-compatible",
                "upstream_url":upstream_url,
                "api_key":"public-secret"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for (combo, model) in [
        ("unlisted", "unlisted-model"),
        ("published", "custom-model"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/combos/{combo}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "strategy":"priority",
                    "fallback":true,
                    "targets":[{"provider_id":"public-account","model":model}]
                }))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
            "{combo}"
        );
    }
    let key = "public-client-key-123456789";
    let granted = "granted-client-key-123456789";
    for (id, secret, combos) in [
        ("public-client", key, serde_json::Value::Null),
        ("granted-client", granted, serde_json::json!(["unlisted"])),
    ] {
        let saved: serde_json::Value = client
            .put(format!("{base}/api/admin/client-keys/{id}"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":id,
                "api_key":secret,
                "scopes":["inference:chat"],
                "allowed_combos":combos,
                "public_models_only":true
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(saved["client_key"]["public_models_only"], true, "{id}");
    }
    let listed = |key: &'static str| {
        let (client, base) = (client.clone(), base.clone());
        async move {
            let models: serde_json::Value = client
                .get(format!("{base}/v1/models"))
                .bearer_auth(key)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let mut ids = models["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|model| model["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            ids.sort();
            ids
        }
    };

    // Nothing is published yet: neither combo target is reachable or listed.
    for combo in ["unlisted", "published"] {
        assert_eq!(
            chat_model(&client, &base, key, combo).await.status(),
            StatusCode::FORBIDDEN,
            "{combo}"
        );
    }
    assert!(listed(key).await.is_empty());

    // A custom model publishes its target; a hidden one does not.
    for (model, hidden) in [("custom-model", false), ("unlisted-model", true)] {
        assert_eq!(
            client
                .post(format!("{base}/api/admin/provider-models"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"openai-compatible",
                    "metadata":{"id":model},
                    "hidden":hidden
                }))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
            "{model}"
        );
    }
    assert_eq!(
        chat_model(&client, &base, key, "published").await.status(),
        StatusCode::OK
    );
    assert_eq!(
        chat_model(&client, &base, key, "unlisted").await.status(),
        StatusCode::FORBIDDEN
    );
    // The published custom model is also listed directly; the hidden one and
    // the combo that only reaches it are not.
    assert_eq!(
        listed(key).await,
        ["openai-compatible/custom-model", "published"]
    );

    // A curated combo granted by name is admitted without judging targets.
    assert_eq!(
        chat_model(&client, &base, granted, "unlisted")
            .await
            .status(),
        StatusCode::OK
    );

    gateway_task.abort();
    upstream_task.abort();
}
