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
            Json(serde_json::json!({"data":[{"id":"model-b","modelType":"image","supportedEndpoints":["chat","images"],"context_length":32768,"inputTokenLimit":30000,"top_provider":{"max_completion_tokens":4096},"architecture":{"input_modalities":["text","image"],"output_modalities":["text"]},"supported_parameters":["tools"],"supportsThinking":true,"unrelated_secret":"must-not-return"},{"id":"model-a","supportedEndpoints":["images"]}]}))
        }
    });
    let app = Router::new()
        .route("/v1/chat/completions", post(|headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
            assert_eq!(headers["authorization"], "Bearer private-provider-key");
            assert_eq!(headers["x-project"], "private-project");
            assert_eq!(body["model"], "model-b");
            Json(serde_json::json!({"id":"chat-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}))
        }))
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
    assert_eq!(client.post(format!("{endpoint}/adopt-legacy")).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
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
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
    let snapshot = db.synced_models("discovery-fixture", "red", now, 60_000).await.unwrap().unwrap();
    assert!(!snapshot.models_json.contains("private-provider-key"));
    assert!(!snapshot.models_json.contains("must-not-return"));
    assert_eq!(serde_json::from_str::<serde_json::Value>(&snapshot.models_json).unwrap()[0]["id"], "model-a");
    assert!(db.synced_models("discovery-fixture", "other", now, 60_000).await.unwrap().is_none());
    let catalog_key = "discovery-catalog-client-key-123456789";
    assert_eq!(client.put(format!("{base}/api/admin/client-keys/discovery-catalog")).bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"label":"Discovery catalog","api_key":catalog_key,"scopes":["inference:chat"],"allowed_models":["openai-compatible/model-b"],"allowed_provider_ids":["discovery-fixture"]}))
        .send().await.unwrap().status(), StatusCode::OK);
    let listed: serde_json::Value = client.get(format!("{base}/v1/models")).bearer_auth(catalog_key).send().await.unwrap().json().await.unwrap();
    assert_eq!(listed["data"].as_array().unwrap().len(), 1);
    assert_eq!(listed["data"][0]["id"], "openai-compatible/model-b");
    assert_eq!(listed["data"][0]["context_length"], 32768);
    assert_eq!(listed["data"][0]["max_input_tokens"], 30000);
    assert_eq!(listed["data"][0]["capabilities"]["vision"], true);
    assert_eq!(listed["data"][0]["capabilities"]["tool_calling"], true);
    assert_eq!(listed["data"][0]["capabilities"]["reasoning"], true);
    let broad_key = "discovery-broad-client-key-123456789";
    assert_eq!(client.put(format!("{base}/api/admin/client-keys/discovery-broad")).bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"label":"Discovery broad","api_key":broad_key,"scopes":["inference:chat"],"allowed_models":["openai-compatible/model-a","openai-compatible/model-b"],"allowed_provider_ids":["discovery-fixture"]}))
        .send().await.unwrap().status(), StatusCode::OK);
    let listed: serde_json::Value = client.get(format!("{base}/v1/models")).bearer_auth(broad_key).send().await.unwrap().json().await.unwrap();
    assert_eq!(listed["data"].as_array().unwrap().len(), 1);
    assert_eq!(listed["data"][0]["id"], "openai-compatible/model-b");
    let response = chat_model(&client, &base, catalog_key, "openai-compatible/model-b").await;
    assert_eq!(response.status(), StatusCode::OK);
    let response: serde_json::Value = response.json().await.unwrap();
    assert_eq!(response["choices"][0]["message"]["content"], "ok");
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
    assert!(db.synced_models("discovery-fixture", "red", now, 60_000).await.unwrap().is_none());
    let listed: serde_json::Value = client.get(format!("{base}/v1/models")).bearer_auth(catalog_key).send().await.unwrap().json().await.unwrap();
    assert!(listed["data"].as_array().unwrap().is_empty());
    // A fresh connection/control plane reads the durable configuration without a hot-path cache.
    let db2 = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control2 = ControlPlane::new(db2, ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base2, gateway2_task) = gateway(control2).await;
    let endpoint2 = format!("{base2}/api/admin/providers/discovery-fixture/discovery");
    let view: serde_json::Value = client.get(&endpoint2).bearer_auth(ADMIN_KEY).send().await.unwrap().json().await.unwrap();
    assert_eq!(view["models_path"], "/custom/models?version=2");
    assert_eq!(client.post(&endpoint2).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(seen.lock().unwrap().last().unwrap().1, "/custom/models?version=2");
    assert!(db.synced_models("discovery-fixture", "red", now + 5_000, 60_000).await.unwrap().is_some());
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let listed: serde_json::Value = client.get(format!("{base}/v1/models")).bearer_auth(catalog_key).send().await.unwrap().json().await.unwrap();
            if listed["data"].as_array().unwrap().iter().any(|model| model["id"] == "openai-compatible/model-b") { break; }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }).await.expect("discovered models were not published to the other proxy");
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

#[tokio::test]
async fn discovered_models_are_scoped_to_permitted_provider_accounts() {
    let dir = TempDir::new().unwrap();
    let file = Url::from_file_path(dir.path().join("account-catalog.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(db, ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base, gateway_task) = gateway(control).await;
    let app = Router::new().route("/v1/models", get(|headers: HeaderMap| async move {
        let (model, endpoint) = match headers["authorization"].to_str().unwrap() {
            "Bearer account-a-secret" => ("private-model-a", "images"),
            "Bearer account-b-secret" => ("private-model-b", "chat"),
            _ => panic!("unexpected provider credential"),
        };
        Json(serde_json::json!({"data":[{"id":model},{"id":"shared-model","supportedEndpoints":[endpoint]}]}))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
    let upstream_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (account, secret) in [("account-a", "account-a-secret"), ("account-b", "account-b-secret")] {
        let endpoint = format!("{base}/api/admin/providers/{account}");
        assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"provider":"openai-compatible","upstream_url":upstream,"api_key":secret}))
            .send().await.unwrap().status(), StatusCode::OK);
        assert_eq!(client.post(format!("{endpoint}/discovery")).bearer_auth(ADMIN_KEY)
            .send().await.unwrap().status(), StatusCode::OK);
    }
    for (account, key, model) in [
        ("account-a", "discovery-account-a-client-key-123456", "openai-compatible/private-model-a"),
        ("account-b", "discovery-account-b-client-key-123456", "openai-compatible/private-model-b"),
    ] {
        assert_eq!(client.put(format!("{base}/api/admin/client-keys/{account}")).bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"label":account,"api_key":key,"scopes":["inference:chat"],
                "allowed_models":["openai-compatible/private-model-a","openai-compatible/private-model-b","openai-compatible/shared-model"],
                "allowed_provider_ids":[account]}))
            .send().await.unwrap().status(), StatusCode::OK);
        let listed: serde_json::Value = client.get(format!("{base}/v1/models"))
            .bearer_auth(key).send().await.unwrap().json().await.unwrap();
        let models = listed["data"].as_array().unwrap();
        assert_eq!(models.len(), if account == "account-b" { 2 } else { 1 }, "{listed}");
        assert_eq!(models[0]["id"], model);
    }
    let combined_key = "discovery-combined-client-key-123456";
    assert_eq!(client.put(format!("{base}/api/admin/client-keys/both-accounts")).bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"label":"Both accounts","api_key":combined_key,"scopes":["inference:chat"],
            "allowed_models":["openai-compatible/shared-model"],"allowed_provider_ids":["account-a","account-b"]}))
        .send().await.unwrap().status(), StatusCode::OK);
    let listed: serde_json::Value = client.get(format!("{base}/v1/models")).bearer_auth(combined_key).send().await.unwrap().json().await.unwrap();
    assert_eq!(listed["data"].as_array().unwrap().len(), 1, "{listed}");
    assert_eq!(listed["data"][0]["id"], "openai-compatible/shared-model");
    upstream_task.abort();
    gateway_task.abort();
}

#[tokio::test]
async fn local_model_requests_choose_only_hosts_that_advertise_the_model() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("local-model-routing.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base, gateway_task) = gateway(control).await;
    let calls = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = calls.clone();
    let upstream = Router::new()
        .route("/v1/models", get(|headers: HeaderMap| async move {
            let id = match headers["authorization"].to_str().unwrap() {
                "Bearer host-a-secret" => "model-a",
                "Bearer host-b-secret" => "model-b",
                _ => panic!("unexpected credential"),
            };
            Json(serde_json::json!({"data":[{"id":id}]}))
        }))
        .route("/v1/chat/completions", post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
            let seen = seen.clone();
            async move {
                let credential = headers["authorization"].to_str().unwrap();
                let expected = if credential == "Bearer host-a-secret" { "model-a" } else { "model-b" };
                seen.lock().unwrap().push(format!("{credential}:{}", body["model"].as_str().unwrap()));
                if body["model"] != expected { return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error":"model unavailable"}))); }
                (StatusCode::OK, Json(serde_json::json!({"id":"local-chat","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})))
            }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
    let upstream_task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap(); });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (account, secret) in [("host-a", "host-a-secret"), ("host-b", "host-b-secret")] {
        let endpoint = format!("{base}/api/admin/providers/{account}");
        assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"provider":"vllm","upstream_url":url,"api_key":secret})).send().await.unwrap().status(), StatusCode::OK);
        assert_eq!(client.post(format!("{endpoint}/discovery")).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::OK);
    }
    let key = "local-inventory-client-key-123456789";
    assert_eq!(client.put(format!("{base}/api/admin/client-keys/local-routing")).bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"label":"Local routing","api_key":key,"scopes":["inference:chat"],"allowed_models":["vllm/*"],"allowed_provider_ids":["host-a","host-b"]}))
        .send().await.unwrap().status(), StatusCode::OK);
    for model in ["model-a", "model-b"] {
        assert_eq!(chat_model(&client, &base, key, &format!("vllm/{model}")).await.status(), StatusCode::OK);
    }
    assert_eq!(chat_model(&client, &base, key, "vllm/model-c").await.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(*calls.lock().unwrap(), vec!["Bearer host-a-secret:model-a", "Bearer host-b-secret:model-b"]);
    upstream_task.abort();
    gateway_task.abort();
}
