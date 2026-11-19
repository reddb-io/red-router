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
    let config = serde_json::json!({"provider":"openai-compatible", "upstream_url":upstream, "api_key":"provider-secret", "label":"é".repeat(200)});
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

// Legacy `upstreamHeaders` on a model (buildUpstreamHeadersForExecute): merged
// over the account's custom headers for that model only, values write-only.
#[tokio::test]
async fn model_headers_override_account_headers_for_that_model_only() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("model-headers.sqlite")).unwrap();
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let upstream_task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let admin_put = |path: String, body: serde_json::Value| {
        let client = client.clone();
        async move {
            client
                .put(path)
                .bearer_auth(ADMIN_KEY)
                .json(&body)
                .send()
                .await
                .unwrap()
        }
    };
    assert_eq!(
        admin_put(
            format!("{base}/api/admin/providers/custom"),
            serde_json::json!({"provider":"openai-compatible","upstream_url":upstream,"api_key":"provider-secret"}),
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        admin_put(
            format!("{base}/api/admin/providers/custom/headers"),
            serde_json::json!({"headers":{"x-title":"account-title","x-account-only":"kept"}}),
        )
        .await
        .status(),
        StatusCode::OK
    );
    for (combo, model) in [("model-headers", "fixture-model"), ("other-headers", "other-model")] {
        assert_eq!(
            admin_put(
                format!("{base}/api/admin/combos/{combo}"),
                serde_json::json!({"protocol":"openai","strategy":"priority","targets":[{"provider_id":"custom","model":model}]}),
            )
            .await
            .status(),
            StatusCode::OK
        );
    }
    let created: serde_json::Value = client
        .post(format!("{base}/api/admin/provider-models"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"provider":"openai-compatible","metadata":{"id":"fixture-model"}}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["model"]["id"].as_str().unwrap().to_owned();
    let revision = created["model"]["revision"].as_str().unwrap().to_owned();
    let endpoint = format!("{base}/api/admin/provider-models/{id}/headers");
    assert_eq!(
        client.get(&endpoint).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        admin_put(
            endpoint.clone(),
            serde_json::json!({"headers":{"Authorization":"Bearer bad"},"revision":revision}),
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        admin_put(
            endpoint.clone(),
            serde_json::json!({"headers":{"x-title":"stale"},"revision":"1"}),
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let response = admin_put(
        endpoint.clone(),
        serde_json::json!({"headers":{"X-Title":"model-secret-title"},"revision":revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let text = response.text().await.unwrap();
    assert!(text.contains("x-title"), "{text}");
    assert!(!text.contains("model-secret-title"), "{text}");
    let stored = database.provider_models().await.unwrap();
    let ciphertext = stored[0].headers_ciphertext.as_deref().unwrap();
    assert!(!ciphertext.contains("model-secret-title"));
    let last = |seen: &Arc<Mutex<Vec<HeaderMap>>>| seen.lock().unwrap().last().unwrap().clone();
    assert_eq!(
        chat_model(&client, &base, CLIENT_KEY, "model-headers")
            .await
            .status(),
        StatusCode::OK
    );
    let request = last(&seen);
    assert_eq!(request["x-title"], "model-secret-title");
    assert_eq!(request["x-account-only"], "kept");
    assert_eq!(
        chat_model(&client, &base, CLIENT_KEY, "other-headers")
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(last(&seen)["x-title"], "account-title");
    // A metadata edit keeps the headers, and a restart decrypts them again.
    let view: serde_json::Value = client
        .get(&endpoint)
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(view["names"], serde_json::json!(["x-title"]));
    let edited = admin_put(
        format!("{base}/api/admin/provider-models/{id}"),
        serde_json::json!({"provider":"openai-compatible","metadata":{"id":"fixture-model","name":"Fixture"},"revision":view["revision"]}),
    )
    .await;
    assert_eq!(edited.status(), StatusCode::OK);
    let restarted = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, true)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    assert_eq!(
        chat_model(&client, &restarted_base, CLIENT_KEY, "model-headers")
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(last(&seen)["x-title"], "model-secret-title");
    // Clearing the model headers falls back to the account's.
    let edited: serde_json::Value = edited.json().await.unwrap();
    assert_eq!(
        admin_put(
            endpoint.clone(),
            serde_json::json!({"headers":{},"revision":edited["model"]["revision"]}),
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert!(database.provider_models().await.unwrap()[0]
        .headers_ciphertext
        .is_none());
    assert_eq!(
        chat_model(&client, &base, CLIENT_KEY, "model-headers")
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(last(&seen)["x-title"], "account-title");
    restarted_task.abort();
    gateway_task.abort();
    upstream_task.abort();
}
