#[tokio::test]
async fn provider_custom_headers_persist_dispatch_and_never_expose_values() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("headers.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, true)
        .await
        .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let seen = Arc::new(Mutex::new(Vec::<HeaderMap>::new()));
    let captured = seen.clone();
    let app = Router::new().route("/v1/chat/completions", post(move |headers: HeaderMap| {
        let captured = captured.clone();
        async move {
            captured.lock().unwrap().push(headers);
            Json(serde_json::json!({"id":"fixture", "object":"chat.completion", "model":"fixture-model", "choices":[{"index":0,"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}))
        }
    }));
    let app = app.clone().nest("/other", app);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let upstream_task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let config = serde_json::json!({"provider":"openai-compatible", "upstream_url":upstream, "api_key":"provider-secret", "label":"Fixture"});
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/custom"))
            .bearer_auth(ADMIN_KEY)
            .json(&config)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let endpoint = format!("{base}/api/admin/providers/custom/headers");
    assert_eq!(
        client.get(&endpoint).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    for headers in [
        serde_json::json!({"Authorization":"Bearer bad"}),
        serde_json::json!({"x-title":"bad\r\nheader"}),
        serde_json::json!({"X-Title":"one","x-title":"two"}),
    ] {
        assert_eq!(
            client
                .put(&endpoint)
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({"headers":headers}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let response = client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"headers":{"X-Title":"private-project-title","Accept":"application/json","Content-Type":"application/x-fixture+json"}})).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let text = response.text().await.unwrap();
    assert!(!text.contains("private-project-title"));
    assert!(text.contains("x-title"));
    let stored = database.provider_headers().await.unwrap();
    assert_eq!(stored.len(), 1);
    assert!(!stored[0]
        .headers_ciphertext
        .contains("private-project-title"));
    assert_eq!(
        chat(&client, &base, CLIENT_KEY).await.status(),
        StatusCode::OK
    );
    {
        let requests = seen.lock().unwrap();
        assert_eq!(requests.last().unwrap()["x-title"], "private-project-title");
        assert_eq!(
            requests.last().unwrap()["content-type"],
            "application/x-fixture+json"
        );
        assert_eq!(
            requests
                .last()
                .unwrap()
                .get_all("content-type")
                .iter()
                .count(),
            1
        );
        assert_eq!(
            requests.last().unwrap()["authorization"],
            "Bearer provider-secret"
        );
        assert_eq!(requests.last().unwrap().get_all("accept").iter().count(), 1);
    }
    // Metadata edits and credential replacement must preserve the map.
    let mut edit = config.clone();
    edit["api_key"] = serde_json::json!("");
    edit["label"] = serde_json::json!("Renamed");
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/custom"))
            .bearer_auth(ADMIN_KEY)
            .json(&edit)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let restarted = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, true)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    assert_eq!(
        chat(&client, &restarted_base, CLIENT_KEY).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        seen.lock().unwrap().last().unwrap()["x-title"],
        "private-project-title"
    );
    // Diagnostics use the same map, not a separate credential-only client.
    let diagnostic = client
        .post(format!("{base}/api/admin/providers/custom/test"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"model":"fixture-model"}))
        .send()
        .await
        .unwrap();
    assert_eq!(diagnostic.status(), StatusCode::OK);
    assert_eq!(
        seen.lock().unwrap().last().unwrap()["x-title"],
        "private-project-title"
    );
    let combo = serde_json::json!({"protocol":"openai","strategy":"priority","targets":[{"provider_id":"custom","model":"fixture-model"}]});
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/headers-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&combo)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        chat_model(&client, &base, CLIENT_KEY, "headers-combo")
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        seen.lock().unwrap().last().unwrap()["x-title"],
        "private-project-title"
    );
    let audit = client
        .get(format!(
            "{base}/api/admin/audit-log?action=provider.headers.update"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(audit.contains("x-title"));
    assert!(!audit.contains("private-project-title"));
    // Changing the destination must not carry private values to the new endpoint.
    edit["api_key"] = serde_json::json!("provider-secret");
    edit["upstream_url"] = serde_json::json!(upstream.replace("/v1/", "/other/v1/"));
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/custom"))
            .bearer_auth(ADMIN_KEY)
            .json(&edit)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let view: serde_json::Value = client
        .get(&endpoint)
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(view["attached"], false);
    assert_eq!(
        chat_model(&client, &base, CLIENT_KEY, "headers-combo")
            .await
            .status(),
        StatusCode::OK
    );
    assert!(!seen.lock().unwrap().last().unwrap().contains_key("x-title"));
    assert_eq!(
        client
            .put(&endpoint)
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"headers":{}}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert!(database.provider_headers().await.unwrap().is_empty());
    // Refresh the follower after clearing; the ordinary shared SQLite watcher must converge.
    for _ in 0..100 {
        assert_eq!(
            chat_model(&client, &restarted_base, CLIENT_KEY, "headers-combo")
                .await
                .status(),
            StatusCode::OK
        );
        if !seen.lock().unwrap().last().unwrap().contains_key("x-title") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!seen.lock().unwrap().last().unwrap().contains_key("x-title"));
    restarted_task.abort();
    gateway_task.abort();
    upstream_task.abort();
}
