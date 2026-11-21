// A legacy combo target names a provider pool (`provider/model`): the combo
// tries every account of that provider, in account priority order, before
// its next target. The native `provider-pool` target keeps that meaning under
// a priority combo and is refused elsewhere.
#[tokio::test]
async fn provider_pool_targets_try_the_pool_accounts_in_priority_order() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("provider-pool.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (failing_url, failing_task) = failing_provider("pool-first-secret").await;
    let (serving_url, serving_task) = provider("pool-second-secret", "pool-second").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (id, upstream_url, api_key, priority) in [
        ("pool-second", serving_url, "pool-second-secret", 2),
        ("pool-first", failing_url, "pool-first-secret", 1),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"openai-compatible",
                    "upstream_url":upstream_url,
                    "api_key":api_key,
                    "priority":priority
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
            .put(format!("{base}/api/admin/client-keys/pool-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"label":"Pool", "api_key":RUST_CLIENT_KEY, "enabled":true}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    // Only a priority combo keeps the pool's account order meaningful.
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/pool-round-robin"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"round-robin",
                "targets":[{"kind":"provider-pool","provider_id":"openai-compatible","model":"pool-model"}]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/pool-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"priority",
                "fallback":true,
                "targets":[{"kind":"provider-pool","provider_id":"openai-compatible","model":"pool-model"}]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    // The priority-1 account fails; the pool's next account serves.
    let response = chat_model(&client, &base, RUST_CLIENT_KEY, "pool-combo").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "pool-second");

    gateway_task.abort();
    failing_task.abort();
    serving_task.abort();
}
