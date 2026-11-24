#[tokio::test]
async fn client_key_catalog_policy_shapes_the_model_listing() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("key-catalog.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (upstream_url, upstream_task) = provider("catalog-secret", "ok").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/catalog-account"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"openai-compatible",
                "upstream_url":upstream_url,
                "api_key":"catalog-secret"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for combo in ["team", "auto"] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/combos/{combo}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "strategy":"priority",
                    "fallback":true,
                    "targets":[{"provider_id":"catalog-account","model":"upstream-model"}]
                }))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
            "{combo}"
        );
    }

    let listed = |key: &'static str, policy: serde_json::Value| {
        let (client, base) = (client.clone(), base.clone());
        async move {
            let id = key.trim_end_matches("-client-key-123456789");
            let mut body = serde_json::json!({
                "label":id,
                "api_key":key,
                "scopes":["inference:chat"]
            });
            body.as_object_mut()
                .unwrap()
                .extend(policy.as_object().unwrap().clone());
            let saved = client
                .put(format!("{base}/api/admin/client-keys/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&body)
                .send()
                .await
                .unwrap();
            assert_eq!(saved.status(), StatusCode::OK, "{id}");
            let view: serde_json::Value = saved.json().await.unwrap();
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
            (view, ids)
        }
    };

    let (view, all) = listed("all-client-key-123456789", serde_json::json!({})).await;
    assert_eq!(view["client_key"]["catalog_scope"], "all");
    assert_eq!(view["client_key"]["list_auto_combos"], true);
    assert_eq!(all, ["auto", "team"]);

    let (view, no_auto) = listed(
        "noauto-client-key-123456789",
        serde_json::json!({"list_auto_combos":false}),
    )
    .await;
    assert_eq!(view["client_key"]["list_auto_combos"], false);
    assert_eq!(no_auto, ["team"]);

    let (_, combos) = listed(
        "combos-client-key-123456789",
        serde_json::json!({"catalog_scope":"combos"}),
    )
    .await;
    assert_eq!(combos, ["auto", "team"]);

    let (view, models) = listed(
        "models-client-key-123456789",
        serde_json::json!({"catalog_scope":"models"}),
    )
    .await;
    assert_eq!(view["client_key"]["catalog_scope"], "models");
    assert!(models.is_empty(), "{models:?}");

    // An update that omits the catalog fields keeps the stored policy.
    let (view, kept) = listed("noauto-client-key-123456789", serde_json::json!({})).await;
    assert_eq!(view["client_key"]["list_auto_combos"], false);
    assert_eq!(kept, ["team"]);
    // Listing does not change routing: the unlisted combo still dispatches.
    assert_eq!(
        chat_model(&client, &base, "noauto-client-key-123456789", "auto")
            .await
            .status(),
        StatusCode::OK
    );

    gateway_task.abort();
    upstream_task.abort();
}
