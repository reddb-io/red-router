#[tokio::test]
async fn provider_model_discovery_uses_saved_credentials_paths_and_network_boundaries() {
    let dir = TempDir::new().unwrap();
    let file = Url::from_file_path(dir.path().join("discovery.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(db.clone(), ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base, gateway_task) = gateway(control).await;
    let seen = Arc::new(Mutex::new(Vec::<(HeaderMap, String)>::new()));
    let capture = seen.clone();
    let leaked = Arc::new(AtomicUsize::new(0));
    let leaked_handler = leaked.clone();
    let models = get(move |headers: HeaderMap, uri: axum::http::Uri| {
        let capture = capture.clone();
        async move {
            capture.lock().unwrap().push((headers, uri.to_string()));
            Json(serde_json::json!({"data":[{"id":"model-b","context_length":32768,"top_provider":{"max_completion_tokens":4096},"unrelated_secret":"must-not-return"},{"id":"model-a"}]}))
        }
    });
    let app = Router::new()
        .route("/pages/models", get(|headers: HeaderMap, axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>| async move {
            assert_eq!(headers["authorization"], "Bearer private-provider-key");
            assert_eq!(headers["x-project"], "private-project");
            let token_format = query.get("kind").is_some_and(|value| value == "token");
            let parameter = if token_format { "pageToken" } else { "after_id" };
            if let Some(token) = query.get(parameter) {
                assert_eq!(token, "//evil.test/?x=y & cursor");
                Json(serde_json::json!({"data":[{"id":"page-2"}],"has_more":false}))
            } else if token_format {
                Json(serde_json::json!({"data":[{"id":"page-1"}],"nextPageToken":"//evil.test/?x=y & cursor"}))
            } else {
                Json(serde_json::json!({"data":[{"id":"page-1"}],"has_more":true,"last_id":"//evil.test/?x=y & cursor"}))
            }
        }))
        .route("/cycle/models", get(|| async { Json(serde_json::json!({"data":[],"nextPageToken":"repeated"})) }))
        .route("/v1/models", models.clone())
        .route("/custom/models", models)
        .route("/redirect/models", get(|| async { (StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, "/leak")]) }))
        .route("/leak", get(move || { let leaked_handler = leaked_handler.clone(); async move { leaked_handler.fetch_add(1, Ordering::SeqCst); "credential leaked" } }))
        .route("/bad/models", get(|| async { (StatusCode::UNAUTHORIZED, "private-provider-key error") }))
        .route("/large/models", get(|| async { "x".repeat(2 * 1024 * 1024 + 1) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
    let upstream_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let provider_endpoint = format!("{base}/api/admin/providers/discovery-fixture");
    let input = serde_json::json!({"provider":"openai-compatible","upstream_url":upstream,"api_key":"private-provider-key"});
    assert_eq!(client.put(&provider_endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(client.put(format!("{provider_endpoint}/headers")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"headers":{"X-Project":"private-project"}})).send().await.unwrap().status(), StatusCode::OK);
    let endpoint = format!("{provider_endpoint}/discovery");
    for method in [reqwest::Method::GET, reqwest::Method::PUT, reqwest::Method::POST] {
        assert_eq!(client.request(method, &endpoint).json(&serde_json::json!({"models_path":null})).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    }
    let view: serde_json::Value = client.get(&endpoint).bearer_auth(ADMIN_KEY).send().await.unwrap().json().await.unwrap();
    assert!(view["models_path"].is_null());
    assert_eq!(view["effective_models_path"], "/v1/models");
    let response = client.post(&endpoint).bearer_auth(ADMIN_KEY).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = response.text().await.unwrap();
    assert!(!body.contains("private-provider-key") && !body.contains("must-not-return"));
    let models: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(models["models"][0]["id"], "model-a");
    assert_eq!(models["models"][1]["max_output_tokens"], 4096);
    {
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0["authorization"], "Bearer private-provider-key");
        assert_eq!(requests[0].0["x-project"], "private-project");
        assert_eq!(requests[0].1, "/v1/models");
    }
    for path in ["https://evil.test/models", "//evil.test/models", "/\\evil.test/models", "/models\n"] {
        assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"models_path":path})).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
    }
    assert!(db.provider_discovery("discovery-fixture").await.unwrap().is_none());
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"models_path":"/custom/models?version=2"})).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(db.provider_discovery("discovery-fixture").await.unwrap().unwrap().models_path, "/custom/models?version=2");
    // A fresh connection/control plane reads the durable configuration without a hot-path cache.
    let db2 = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control2 = ControlPlane::new(db2, ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base2, gateway2_task) = gateway(control2).await;
    let endpoint2 = format!("{base2}/api/admin/providers/discovery-fixture/discovery");
    let view: serde_json::Value = client.get(&endpoint2).bearer_auth(ADMIN_KEY).send().await.unwrap().json().await.unwrap();
    assert_eq!(view["models_path"], "/custom/models?version=2");
    assert_eq!(client.post(&endpoint2).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(seen.lock().unwrap().last().unwrap().1, "/custom/models?version=2");
    for path in ["/pages/models?kind=token", "/pages/models?kind=cursor"] {
        assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"models_path":path})).send().await.unwrap().status(), StatusCode::OK);
        let response = client.post(&endpoint2).bearer_auth(ADMIN_KEY).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["models"].as_array().unwrap().len(), 2);
        assert_eq!(body["models"][1]["id"], "page-2");
    }
    for (path, message) in [("/redirect/models", "redirected"), ("/bad/models", "rejected"), ("/large/models", "exceeds")] {
        assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"models_path":path})).send().await.unwrap().status(), StatusCode::OK);
        let response = client.post(&endpoint2).bearer_auth(ADMIN_KEY).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = response.text().await.unwrap();
        assert!(body.contains(message), "{body}");
        assert!(!body.contains("private-provider-key"));
    }
    assert_eq!(leaked.load(Ordering::SeqCst), 0);
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"models_path":null})).send().await.unwrap().status(), StatusCode::OK);
    assert!(db.provider_discovery("discovery-fixture").await.unwrap().is_none());
    assert_eq!(client.post(&endpoint2).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::OK);
    let audit = db.audit_events(None).await.unwrap();
    assert!(audit.iter().any(|event| event.action == "provider.discovery.update"));
    assert!(!format!("{audit:?}").contains("private-provider-key"));
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"models_path":"/custom/models"})).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(client.delete(&provider_endpoint).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    assert_eq!(client.delete(format!("{provider_endpoint}/purge")).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    assert!(db.provider_discovery("discovery-fixture").await.unwrap().is_none());
    upstream_task.abort(); gateway_task.abort(); gateway2_task.abort();
}
