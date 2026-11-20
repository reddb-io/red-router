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
    let wait_setting = |enabled: bool| {
        client
            .put(format!(
                "{base}/api/admin/global-settings/wait_for_cooldown"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "enabled":enabled,
                "max_retries":3,
                "max_retry_wait_sec":30,
                "budget_ms":300000
            }))
            .send()
    };

    // The first 429 starts a short connection cooldown; the request waits
    // for it and the retry serves it.
    let flip_requests = requests.clone();
    let flip_status = status.clone();
    let flipper = tokio::spawn(async move {
        while flip_requests.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        flip_status.store(StatusCode::OK.as_u16() as usize, Ordering::SeqCst);
    });
    let started = std::time::Instant::now();
    let recovered = chat_model(&client, &base, key, "wait-api/model-1").await;
    assert_eq!(recovered.status(), StatusCode::OK);
    assert!(started.elapsed() >= Duration::from_millis(500));
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    flipper.await.unwrap();

    // Disabled, the 429 is answered at once and the cooling route answers
    // with the cooldown.
    assert_eq!(wait_setting(false).await.unwrap().status(), StatusCode::OK);
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
    assert_eq!(requests.load(Ordering::SeqCst), 3);
    let blocked = chat_model(&client, &base, key, "wait-api/model-1").await;
    assert_eq!(blocked.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(blocked.headers().get(header::RETRY_AFTER).is_some());
    assert_eq!(requests.load(Ordering::SeqCst), 3);

    // Enabled again, a request that finds the route cooling down waits for
    // it instead of failing at once.
    assert_eq!(wait_setting(true).await.unwrap().status(), StatusCode::OK);
    status.store(StatusCode::OK.as_u16() as usize, Ordering::SeqCst);
    let started = std::time::Instant::now();
    let waited = chat_model(&client, &base, key, "wait-api/model-1").await;
    assert_eq!(waited.status(), StatusCode::OK);
    assert!(started.elapsed() >= Duration::from_millis(500));
    assert_eq!(requests.load(Ordering::SeqCst), 4);

    gateway_task.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn combos_wait_for_a_short_rate_limit_lockout() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("combo-wait.sqlite")).unwrap();
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
    let (upstream, requests, status, _body, upstream_task) = counted_status_provider(
        "combo-wait-secret",
        StatusCode::TOO_MANY_REQUESTS,
        Some("1"),
    )
    .await;
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/combo-wait"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"openai",
                "upstream_url":upstream,
                "api_key":"combo-wait-secret"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/combo-wait-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Combo wait client",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["wait-combo","upstream-model"],
                "allowed_provider_ids":["combo-wait"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/wait-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"priority",
                "fallback":true,
                "targets":[{"provider_id":"combo-wait","model":"upstream-model"}]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    // The 429 with a retry hint locks the only target briefly; the combo
    // waits for the lockout and the next pass is served.
    let flip_requests = requests.clone();
    let flip_status = status.clone();
    let flipper = tokio::spawn(async move {
        while flip_requests.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        flip_status.store(StatusCode::OK.as_u16() as usize, Ordering::SeqCst);
    });
    let started = std::time::Instant::now();
    let recovered = chat_model(&client, &base, RUST_CLIENT_KEY, "wait-combo").await;
    assert_eq!(recovered.status(), StatusCode::OK);
    assert!(started.elapsed() >= Duration::from_millis(500));
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    flipper.await.unwrap();

    // Disabled, the combo relays the 429.
    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/global-settings/combo_cooldown_wait"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "enabled":false,
                "max_wait_ms":90000,
                "max_attempts":5,
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
        chat_model(&client, &base, RUST_CLIENT_KEY, "wait-combo")
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(requests.load(Ordering::SeqCst), 3);

    gateway_task.abort();
    upstream_task.abort();
}
