#[tokio::test]
async fn custom_banned_signals_persist_and_park_matching_accounts() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("banned-signals.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (banned_url, banned_requests, _banned_status, banned_body, banned_task) =
        counted_status_provider("banned-secret", StatusCode::FORBIDDEN, None, None).await;
    *banned_body.write().await =
        r#"{"error":{"message":"Account placed under Kestrel review"}}"#.to_owned();
    let (healthy_url, healthy_task) = provider("healthy-secret", "healthy").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let endpoint = format!("{base}/api/admin/banned-signals");

    assert_eq!(
        client.get(&endpoint).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let saved: serde_json::Value = client
        .put(&endpoint)
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"signals":[" kestrel review ","","kestrel review"]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        saved["banned_signals"],
        serde_json::json!(["kestrel review"])
    );
    assert_eq!(
        client
            .put(&endpoint)
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"signals":["bad\nsignal"]}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );

    for (id, upstream_url, api_key) in [
        ("banned", banned_url, "banned-secret"),
        ("healthy", healthy_url, "healthy-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"openai-compatible",
                    "upstream_url":upstream_url,
                    "api_key":api_key
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
            .put(format!("{base}/api/admin/client-keys/banned-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Banned client",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/banned-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"priority",
                "fallback":true,
                "targets":[
                    {"provider_id":"banned","model":"upstream-model"},
                    {"provider_id":"healthy","model":"upstream-model"}
                ]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for _ in 0..2 {
        assert_eq!(
            chat_model(&client, &base, RUST_CLIENT_KEY, "banned-combo")
                .await
                .text()
                .await
                .unwrap(),
            "healthy"
        );
    }
    // The custom signal parks the account as banned, so it is not retried.
    assert_eq!(banned_requests.load(Ordering::SeqCst), 1);
    let health: serde_json::Value = client
        .get(format!("{base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let banned = health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "banned")
        .unwrap();
    assert_eq!(banned["terminal_status"], "banned");

    // The list survives a restart.
    gateway_task.abort();
    let restarted = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    let listed: serde_json::Value = client
        .get(format!("{restarted_base}/api/admin/banned-signals"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        listed["banned_signals"],
        serde_json::json!(["kestrel review"])
    );
    // Leave the process-wide classifier list as other tests expect it.
    assert_eq!(
        client
            .put(format!("{restarted_base}/api/admin/banned-signals"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"signals":[]}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    restarted_task.abort();
    banned_task.abort();
    healthy_task.abort();
}
