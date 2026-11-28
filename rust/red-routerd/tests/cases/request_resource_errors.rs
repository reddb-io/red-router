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
        counted_status_provider("resource-secret", StatusCode::NOT_FOUND, None, None).await;
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

#[tokio::test]
async fn an_opencode_free_tier_refusal_moves_on_without_a_cooldown() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("free-tier.sqlite")).unwrap();
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
    let (refusing_url, refusing_requests, _status, body, refusing_task) =
        counted_status_provider("refusing-secret", StatusCode::FORBIDDEN, None, None).await;
    *body.write().await = r#"{"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}"#.to_owned();
    let (serving_url, serving_task) = provider("serving-secret", "served").await;
    for (id, upstream, credential, priority) in [
        ("opencode-refusing", &refusing_url, "refusing-secret", 1),
        ("opencode-serving", &serving_url, "serving-secret", 2),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"opencode",
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
    let key = "free-tier-client-key-1234567890123456";
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/free-tier-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Free tier client",
                "api_key":key,
                "scopes":["inference:chat"],
                "allowed_models":["opencode/model-1"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    // The refusal falls back to the next account and leaves the refusing
    // one available: the next request tries it again.
    for expected in 1..=2 {
        let response = chat_model(&client, &base, key, "opencode/model-1").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "served");
        assert_eq!(refusing_requests.load(Ordering::SeqCst), expected);
    }

    gateway_task.abort();
    refusing_task.abort();
    serving_task.abort();
}

// Legacy `checkFallbackError` 400 pre-check: the opencode family's
// "Model is unavailable." locks that model for the rule's hour, clamped to the
// 30 minute ceiling of the model lockout, and the request falls back.
#[tokio::test]
async fn an_opencode_model_unavailable_400_locks_the_model_for_the_ceiling() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("model-unavailable.sqlite")).unwrap();
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
    let (busy_url, busy_requests, _status, body, busy_task) =
        counted_status_provider("busy-secret", StatusCode::BAD_REQUEST, None, None).await;
    *body.write().await =
        r#"{"error":{"message":"Upstream request failed: Model is unavailable."}}"#.to_owned();
    let (serving_url, serving_task) = provider("serving-secret", "served").await;
    for (id, upstream, credential, priority) in [
        ("go-busy", &busy_url, "busy-secret", 1),
        ("go-serving", &serving_url, "serving-secret", 2),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"opencode-go",
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
    let key = "model-unavailable-key-1234567890123";
    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/client-keys/model-unavailable-client"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Model unavailable client",
                "api_key":key,
                "scopes":["inference:chat"],
                "allowed_models":["opencode-go/model-1"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for _ in 0..2 {
        let response = chat_model(&client, &base, key, "opencode-go/model-1").await;
        let status = response.status();
        let text = response.text().await.unwrap();
        assert_eq!(status, StatusCode::OK, "{text}");
        assert_eq!(text, "served");
    }
    assert_eq!(busy_requests.load(Ordering::SeqCst), 1);
    let health: serde_json::Value = client
        .get(format!("{base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let busy = health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "go-busy")
        .unwrap();
    assert_eq!(busy["connection_last_status"], serde_json::Value::Null);
    assert_eq!(busy["model_lockouts"][0]["status"], 400);
    let retry_after = busy["model_lockouts"][0]["retry_after_ms"]
        .as_u64()
        .unwrap();
    assert!(
        retry_after > 29 * 60 * 1000 && retry_after <= 30 * 60 * 1000,
        "retry_after_ms {retry_after}"
    );

    gateway_task.abort();
    busy_task.abort();
    serving_task.abort();
}
