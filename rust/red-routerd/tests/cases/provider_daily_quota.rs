#[tokio::test]
async fn daily_quota_text_parks_the_connection_until_the_reset() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("daily-quota.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (quota_url, quota_requests, _quota_status, quota_body, quota_task) =
        counted_status_provider("quota-secret", StatusCode::FORBIDDEN, None).await;
    *quota_body.write().await =
        r#"{"error":{"message":"You have exceeded your daily quota for this model"}}"#.to_owned();
    let (healthy_url, healthy_task) = provider("healthy-secret", "healthy").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    for (id, upstream_url, api_key) in [
        ("quota", quota_url, "quota-secret"),
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
            .put(format!("{base}/api/admin/client-keys/daily-quota-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Daily quota client",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["daily-combo","upstream-model"],
                "allowed_provider_ids":["quota","healthy"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/daily-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"priority",
                "fallback":true,
                "targets":[
                    {"provider_id":"quota","model":"upstream-model"},
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
        let response = chat_model(&client, &base, RUST_CLIENT_KEY, "daily-combo").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "healthy");
    }
    // The parked connection is not retried before its reset.
    assert_eq!(quota_requests.load(Ordering::SeqCst), 1);
    let health: serde_json::Value = client
        .get(format!("{base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let quota = health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "quota")
        .unwrap();
    assert_eq!(quota["connection_last_status"], 403);
    // Without a node clock the lockout lasts until the host's next midnight
    // (UTC here), well past the five-minute ceiling of an ordinary cooldown;
    // only a run in the last five minutes before midnight cannot tell them apart.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let retry_after = quota["connection_retry_after_ms"].as_u64().unwrap();
    assert!(retry_after > 0 && retry_after <= 24 * 60 * 60 * 1_000);
    if now_ms % 86_400_000 < 86_400_000 - 300_000 {
        assert!(retry_after > 300_000, "{retry_after}");
    }

    gateway_task.abort();
    quota_task.abort();
    healthy_task.abort();
}
