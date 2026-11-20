#[tokio::test]
async fn direct_routes_wait_for_a_short_connection_cooldown() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("cooldown-wait.sqlite")).unwrap();
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
    let (upstream, requests, status, _body, upstream_task) =
        counted_status_provider("wait-secret", StatusCode::TOO_MANY_REQUESTS, Some("1")).await;
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/wait-provider"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"wait-api",
                "upstream_url":upstream,
                "api_key":"wait-secret"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let key = "wait-client-key-123456789012345678901";
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/wait-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Wait client",
                "api_key":key,
                "scopes":["inference:chat"],
                "allowed_models":["wait-api/model-1"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    // The 429 starts a short connection cooldown.
    assert_eq!(
        chat_model(&client, &base, key, "wait-api/model-1")
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    status.store(StatusCode::OK.as_u16() as usize, Ordering::SeqCst);
    // The next request waits for the cooldown instead of failing at once.
    let started = std::time::Instant::now();
    let waited = chat_model(&client, &base, key, "wait-api/model-1").await;
    assert_eq!(waited.status(), StatusCode::OK);
    assert!(started.elapsed() >= Duration::from_millis(500));
    assert_eq!(requests.load(Ordering::SeqCst), 2);

    // Disabled, a blocked route answers with the cooldown right away.
    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/global-settings/wait_for_cooldown"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "enabled":false,
                "max_retries":3,
                "max_retry_wait_sec":30,
                "budget_ms":300000
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    status.store(
        StatusCode::TOO_MANY_REQUESTS.as_u16() as usize,
        Ordering::SeqCst,
    );
    assert_eq!(
        chat_model(&client, &base, key, "wait-api/model-1")
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    let blocked = chat_model(&client, &base, key, "wait-api/model-1").await;
    assert_eq!(blocked.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(blocked.headers().get(header::RETRY_AFTER).is_some());
    assert_eq!(requests.load(Ordering::SeqCst), 3);

    gateway_task.abort();
    upstream_task.abort();
}
