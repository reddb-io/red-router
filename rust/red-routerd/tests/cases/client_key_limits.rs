#[tokio::test]
async fn client_key_session_cap_and_throttle_apply_before_dispatch() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("key-limits.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (upstream_url, upstream_task) = provider("limits-secret", "ok").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/limits-account"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"openai-compatible",
                "upstream_url":upstream_url,
                "api_key":"limits-secret"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/limits-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"priority",
                "fallback":true,
                "targets":[{"provider_id":"limits-account","model":"upstream-model"}]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let key = "limits-client-key-123456789";
    let save = |body: serde_json::Value| {
        let (client, base) = (client.clone(), base.clone());
        async move {
            let response = client
                .put(format!("{base}/api/admin/client-keys/limits-client"))
                .bearer_auth(ADMIN_KEY)
                .json(&body)
                .send()
                .await
                .unwrap();
            let status = response.status();
            (status, response.json::<serde_json::Value>().await.unwrap())
        }
    };
    let (status, saved) = save(serde_json::json!({
        "label":"Limits client",
        "api_key":key,
        "scopes":["inference:chat"],
        "max_sessions":1
    }))
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["client_key"]["max_sessions"], 1);
    assert_eq!(saved["client_key"]["throttle_delay_ms"], 0);
    let (status, _) = save(serde_json::json!({
        "label":"Limits client",
        "api_key":key,
        "throttle_delay_ms":300_001
    }))
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let chat = |session: &'static str| {
        let (client, base) = (client.clone(), base.clone());
        async move {
            client
                .post(format!("{base}/v1/chat/completions"))
                .bearer_auth(key)
                .header("x-session-id", session)
                .json(&serde_json::json!({"model":"limits-combo","messages":[]}))
                .send()
                .await
                .unwrap()
                .status()
        }
    };
    assert_eq!(chat("first").await, StatusCode::OK);
    // A second concurrent session exceeds the cap of one.
    assert_eq!(chat("second").await, StatusCode::TOO_MANY_REQUESTS);
    // The registered session keeps working.
    assert_eq!(chat("first").await, StatusCode::OK);

    // The throttle delays each admitted request; omitted fields keep the cap.
    let (status, saved) = save(serde_json::json!({
        "label":"Limits client",
        "api_key":key,
        "scopes":["inference:chat"],
        "throttle_delay_ms":400
    }))
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["client_key"]["max_sessions"], 1);
    let started = std::time::Instant::now();
    assert_eq!(chat("first").await, StatusCode::OK);
    assert!(started.elapsed() >= Duration::from_millis(400));

    gateway_task.abort();
    upstream_task.abort();
}
