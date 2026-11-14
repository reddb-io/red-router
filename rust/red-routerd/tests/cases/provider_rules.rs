#[tokio::test]
async fn provider_exclusions_are_durable_and_enforced_for_direct_alias_and_combo() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("rules.sqlite")).unwrap();
    let db_url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Arc::new(Database::connect(Backend::Sqlite, &db_url).await.unwrap());
    let control = ControlPlane::new(db, ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base, gateway_task) = gateway(control).await;
    let (upstream_a, calls_a, task_a) = alias_test_provider("rules-account-a", StatusCode::OK).await;
    let (upstream_b, calls_b, task_b) = alias_test_provider("rules-account-b", StatusCode::OK).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (id, upstream, secret) in [("rules-a", upstream_a, "rules-account-a"), ("rules-b", upstream_b, "rules-account-b")] {
        assert_eq!(client.put(format!("{base}/api/admin/providers/{id}")).bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"provider":"private-api","upstream_url":upstream,"api_key":secret}))
            .send().await.unwrap().status(), StatusCode::OK);
    }
    let endpoint = format!("{base}/api/admin/providers/rules-a/model-rules");
    assert_eq!(client.get(&endpoint).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let input = serde_json::json!({"excluded_models":["private-*"],"revision":null});
    let response = client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let saved: serde_json::Value = response.json().await.unwrap();
    assert_eq!(saved["excluded_models"], serde_json::json!(["private-*"]));
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap().status(), StatusCode::CONFLICT);
    let key = "rules-client-key-12345678901234567890";
    assert_eq!(client.put(format!("{base}/api/admin/client-keys/rules-key")).bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"label":"Rules","api_key":key,"scopes":["inference:chat"],"allowed_models":["*"],"allowed_provider_ids":["rules-a","rules-b"]}))
        .send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(client.post(format!("{base}/api/admin/model-aliases")).bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"alias":"friendly-rules","provider":"private-api","model":"private-model"}))
        .send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(client.put(format!("{base}/api/admin/combos/rules-combo")).bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"strategy":"priority","fallback":true,"targets":[{"provider_id":"rules-a","model":"private-model"},{"provider_id":"rules-b","model":"private-model"}]}))
        .send().await.unwrap().status(), StatusCode::OK);
    for model in ["private-api/private-model", "friendly-rules", "rules-combo"] {
        assert_eq!(chat_model(&client, &base, key, model).await.status(), StatusCode::OK, "{model}");
    }
    assert!(calls_a.lock().unwrap().is_empty());
    assert_eq!(calls_b.lock().unwrap().len(), 3);
    let restricted = "rules-restricted-client-12345678901234567890";
    assert_eq!(client.put(format!("{base}/api/admin/client-keys/rules-restricted")).bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"label":"Restricted","api_key":restricted,"scopes":["inference:chat"],"allowed_models":["*"],"allowed_provider_ids":["rules-a"]}))
        .send().await.unwrap().status(), StatusCode::OK);
    let catalog: serde_json::Value = client.get(format!("{base}/v1/models")).bearer_auth(restricted).send().await.unwrap().json().await.unwrap();
    assert!(!catalog["data"].as_array().unwrap().iter().any(|model| model["id"] == "friendly-rules" || model["id"] == "rules-combo"));
    assert_ne!(chat_model(&client, &base, restricted, "rules-combo").await.status(), StatusCode::OK);
    let control2 = ControlPlane::new(Arc::new(Database::connect(Backend::Sqlite, &db_url).await.unwrap()), ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base2, gateway2_task) = gateway(control2).await;
    let endpoint2 = format!("{base2}/api/admin/providers/rules-a/model-rules");
    let persisted: serde_json::Value = client.get(&endpoint2).bearer_auth(ADMIN_KEY).send().await.unwrap().json().await.unwrap();
    assert_eq!(persisted, saved);
    assert_eq!(chat_model(&client, &base2, key, "rules-combo").await.status(), StatusCode::OK);
    let revision = saved["revision"].clone();
    let first = client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"excluded_models":["one-*"],"revision":revision})).send();
    let second = client.put(&endpoint2).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"excluded_models":["two-*"],"revision":revision})).send();
    let (first, second) = tokio::join!(first, second);
    let statuses = [first.unwrap().status(), second.unwrap().status()];
    assert!(statuses.contains(&StatusCode::OK) && statuses.contains(&StatusCode::CONFLICT));
    task_a.abort(); task_b.abort(); gateway_task.abort(); gateway2_task.abort();
}
