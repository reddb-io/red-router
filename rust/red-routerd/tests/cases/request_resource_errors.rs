#[tokio::test]
async fn a_missing_request_resource_does_not_lock_the_model() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("resource-404.sqlite")).unwrap();
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
    let (upstream, requests, status, body, upstream_task) =
        counted_status_provider("resource-secret", StatusCode::NOT_FOUND, None).await;
    *body.write().await =
        r#"{"error":{"message":"[404]: Files [file-abc123] were not found","code":"model_not_found"}}"#
            .to_owned();
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/resource-provider"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"resource-api",
                "upstream_url":upstream,
                "api_key":"resource-secret"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let key = "resource-client-key-12345678901234567";
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/resource-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Resource client",
                "api_key":key,
                "scopes":["inference:chat"],
                "allowed_models":["resource-api/model-1"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    // Without the cooldown wait, a locked model answers at once.
    assert_eq!(
        client
            .put(format!("{base}/api/admin/global-settings/wait_for_cooldown"))
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
    // The unknown file belongs to the request: the 404 is relayed and the
    // model stays available for the next request.
    for expected in 1..=2 {
        assert_eq!(
            chat_model(&client, &base, key, "resource-api/model-1")
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(requests.load(Ordering::SeqCst), expected);
    }
    // A bare 404 still locks the model.
    *body.write().await = r#"{"error":{"message":"Not Found"}}"#.to_owned();
    assert_eq!(
        chat_model(&client, &base, key, "resource-api/model-1")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        chat_model(&client, &base, key, "resource-api/model-1")
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(requests.load(Ordering::SeqCst), 3);
    drop(status);

    gateway_task.abort();
    upstream_task.abort();
}
