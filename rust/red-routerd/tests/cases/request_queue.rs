#[tokio::test]
async fn api_key_connections_wait_for_their_request_queue_turn() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("request-queue.sqlite")).unwrap();
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
    let (upstream, requests, _status, _body, upstream_task) =
        counted_status_provider("queue-secret", StatusCode::OK, None).await;
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/queue-provider"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"queue-api",
                "upstream_url":upstream,
                "api_key":"queue-secret"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let key = "queue-client-key-1234567890123456789";
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/queue-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Queue client",
                "api_key":key,
                "scopes":["inference:chat"],
                "allowed_models":["queue-api/model-1"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let queue = |value: serde_json::Value| {
        client
            .put(format!("{base}/api/admin/global-settings/request_queue"))
            .bearer_auth(ADMIN_KEY)
            .json(&value)
            .send()
    };
    let chat = || chat_model(&client, &base, key, "queue-api/model-1");

    // Requests start at least the minimum gap apart.
    assert_eq!(
        queue(serde_json::json!({
            "enabled":true,
            "requests_per_minute":60,
            "min_time_between_requests_ms":400,
            "concurrent_requests":6,
            "max_wait_ms":30000,
            "max_queue_depth":0
        }))
        .await
        .unwrap()
        .status(),
        StatusCode::OK
    );
    let started = std::time::Instant::now();
    for _ in 0..3 {
        assert_eq!(chat().await.status(), StatusCode::OK);
    }
    assert!(started.elapsed() >= Duration::from_millis(800));
    assert_eq!(requests.load(Ordering::SeqCst), 3);

    // Let the last gap pass: new settings refill the reservoir but keep the
    // next start time, as the legacy limiter does.
    tokio::time::sleep(Duration::from_millis(500)).await;
    // A turn past the wait budget fails locally with a 503.
    assert_eq!(
        queue(serde_json::json!({
            "enabled":true,
            "requests_per_minute":1,
            "min_time_between_requests_ms":0,
            "concurrent_requests":6,
            "max_wait_ms":100,
            "max_queue_depth":0
        }))
        .await
        .unwrap()
        .status(),
        StatusCode::OK
    );
    assert_eq!(chat().await.status(), StatusCode::OK);
    assert_eq!(chat().await.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(requests.load(Ordering::SeqCst), 4);

    // Off (the default), nothing waits.
    assert_eq!(
        queue(serde_json::json!({
            "enabled":false,
            "requests_per_minute":1,
            "min_time_between_requests_ms":0,
            "concurrent_requests":6,
            "max_wait_ms":100,
            "max_queue_depth":0
        }))
        .await
        .unwrap()
        .status(),
        StatusCode::OK
    );
    assert_eq!(chat().await.status(), StatusCode::OK);
    assert_eq!(requests.load(Ordering::SeqCst), 5);
    assert_eq!(
        queue(serde_json::json!({"enabled":true}))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );

    gateway_task.abort();
    upstream_task.abort();
}
