#[tokio::test]
async fn reusable_provider_definitions_keep_account_credentials_and_shared_transport_after_restart() {
    let dir = TempDir::new().unwrap();
    let file = Url::from_file_path(dir.path().join("nodes.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(db.clone(), ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base, gateway_task) = gateway(control).await;
    let seen = Arc::new(Mutex::new(Vec::<(String, String, Option<String>, Option<String>)>::new()));
    let observed = seen.clone();
    let infer = post(move |headers: HeaderMap, uri: axum::http::Uri, Json(body): Json<serde_json::Value>| {
        let observed = observed.clone();
        async move {
            observed.lock().unwrap().push((uri.to_string(), headers["authorization"].to_str().unwrap().to_owned(), headers.get("x-project").map(|value| value.to_str().unwrap().to_owned()), headers.get("x-title").map(|value| value.to_str().unwrap().to_owned())));
            Json(serde_json::json!({"id":"node-fixture","object":"chat.completion","model":body["model"],"choices":[{"index":0,"message":{"role":"assistant","content":"node reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}))
        }
    });
    let app = Router::new().route("/v1/infer", infer.clone()).route("/v1/next", infer)
        .route("/v1/catalog", get(|headers: HeaderMap| async move {
            assert_eq!(headers["authorization"], "Bearer account-one-secret");
            assert_eq!(headers["x-project"], "override-secret");
            assert_eq!(headers["x-title"], "gateway");
            Json(serde_json::json!({"data":[{"id":"node-model"}]}))
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_base = format!("http://{}/v1", listener.local_addr().unwrap());
    let upstream_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let endpoint = format!("{base}/api/admin/provider-nodes/shared-gateway");
    let mut node = serde_json::json!({"name":"Company gateway","prefix":"company-gateway","protocol":"openai","base_url":upstream_base,"chat_path":"/infer","models_path":"/catalog"});
    assert_eq!(client.put(&endpoint).json(&node).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    for (field, value) in [("prefix", "openai"), ("prefix", "agy"), ("protocol", "auto"), ("chat_path", "//other.test/infer"), ("models_path", "/models?secret=x")] {
        let mut invalid = node.clone(); invalid[field] = value.into();
        assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&invalid).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
    }
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&node).send().await.unwrap().status(), StatusCode::OK);
    let headers_endpoint = format!("{endpoint}/headers");
    assert_eq!(client.get(&headers_endpoint).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(client.put(&headers_endpoint).json(&serde_json::json!({"headers":{}})).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    for name in ["Authorization", "Cookie", "Host", "X-Forwarded-For"] {
        assert_eq!(client.put(&headers_endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"headers":{name:"forbidden"}})).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
    }
    let header_response = client.put(&headers_endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"headers":{"X-Project":"shared-secret","X-Title":"gateway"}})).send().await.unwrap();
    assert_eq!(header_response.status(), StatusCode::OK);
    let header_response = header_response.text().await.unwrap();
    assert!(!header_response.contains("shared-secret"));
    assert!(db.provider_nodes().await.unwrap()[0].header_config.as_ref().unwrap().ciphertext.starts_with("rr:v1:"));
    let view: serde_json::Value = client.get(format!("{base}/api/admin/provider-nodes")).bearer_auth(ADMIN_KEY).send().await.unwrap().json().await.unwrap();
    assert_eq!(view["nodes"][0]["upstream_url"], format!("{upstream_base}/infer"));
    assert!(view["nodes"][0]["revision"].is_string());
    assert!(view["nodes"][0].get("header_config").is_none());
    assert!(!view.to_string().contains("shared-secret") && !view.to_string().contains("ciphertext"));
    assert_eq!(client.put(format!("{base}/api/admin/provider-nodes/duplicate-prefix")).bearer_auth(ADMIN_KEY).json(&node).send().await.unwrap().status(), StatusCode::CONFLICT);
    for (id, key) in [("node-one", "account-one-secret"), ("node-two", "account-two-secret")] {
        let response = client.put(format!("{base}/api/admin/providers/{id}")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"node_id":"shared-gateway","api_key":key})).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let view: serde_json::Value = response.json().await.unwrap();
        assert_eq!(view["provider"]["node_id"], "shared-gateway");
        assert_eq!(view["provider"]["provider"], "company-gateway");
        assert!(!view.to_string().contains(key));
        if id == "node-one" {
            assert_eq!(client.put(format!("{base}/api/admin/providers/{id}/headers")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"headers":{"x-project":"override-secret"}})).send().await.unwrap().status(), StatusCode::OK);
        }
        let probe: serde_json::Value = client.post(format!("{base}/api/admin/providers/{id}/test")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"model":"node-model"})).send().await.unwrap().json().await.unwrap();
        assert_eq!(probe["diagnostic"]["ok"], true);
        assert_eq!(seen.lock().unwrap().last().unwrap().1, format!("Bearer {key}"));
        assert_eq!(seen.lock().unwrap().last().unwrap().2.as_deref(), Some(if id == "node-one" { "override-secret" } else { "shared-secret" }));
        assert_eq!(seen.lock().unwrap().last().unwrap().3.as_deref(), Some("gateway"));
    }
    let discovery: serde_json::Value = client.get(format!("{base}/api/admin/providers/node-one/discovery")).bearer_auth(ADMIN_KEY).send().await.unwrap().json().await.unwrap();
    assert_eq!(discovery["effective_models_path"], "/v1/catalog");
    assert_eq!(client.post(format!("{base}/api/admin/providers/node-one/discovery")).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::OK);
    let combo_endpoint = format!("{base}/api/admin/combos/node-combo");
    assert_eq!(client.put(&combo_endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"protocol":"openai","strategy":"priority","targets":[{"provider_id":"node-one","model":"node-model"}]})).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(chat_model(&client, &base, CLIENT_KEY, "node-combo").await.status(), StatusCode::OK);
    assert_eq!(client.delete(&endpoint).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::CONFLICT);
    node["chat_path"] = "/next".into();
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&node).send().await.unwrap().status(), StatusCode::CONFLICT);
    assert!(db.providers().await.unwrap().iter().all(|p| p.upstream_url.ends_with("/infer")));
    node["apply_to_connections"] = true.into();
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&node).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(chat_model(&client, &base, CLIENT_KEY, "node-combo").await.status(), StatusCode::OK);
    assert_eq!(seen.lock().unwrap().last().unwrap().0, "/v1/next");
    assert!(seen.lock().unwrap().last().unwrap().2.is_none());
    let detached: serde_json::Value = client.get(&headers_endpoint).bearer_auth(ADMIN_KEY).send().await.unwrap().json().await.unwrap();
    assert_eq!(detached["attached"], false);
    let stale = db.provider_nodes().await.unwrap()[0].clone();
    assert_eq!(client.put(&headers_endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"headers":{"X-Project":"second-shared"}})).send().await.unwrap().status(), StatusCode::OK);
    let mut stale_update = stale.clone(); stale_update.revision += 1; stale_update.name = "must-not-overwrite-new-headers".into();
    assert!(db.upsert_provider_node(&stale_update, Some(stale.revision)).await.is_err());
    assert_eq!(chat_model(&client, &base, CLIENT_KEY, "node-combo").await.status(), StatusCode::OK);
    assert_eq!(seen.lock().unwrap().last().unwrap().2.as_deref(), Some("second-shared"));
    node["protocol"] = "anthropic".into();
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&node).send().await.unwrap().status(), StatusCode::CONFLICT);
    assert_eq!(db.provider_nodes().await.unwrap()[0].protocol, "openai");
    let db2 = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control2 = ControlPlane::new(db2.clone(), ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base2, task2) = gateway(control2).await;
    assert_eq!(chat_model(&client, &base2, CLIENT_KEY, "node-combo").await.status(), StatusCode::OK);
    assert_eq!(seen.lock().unwrap().last().unwrap().0, "/v1/next");
    assert_eq!(seen.lock().unwrap().last().unwrap().2.as_deref(), Some("second-shared"));
    // Competing connections must not silently lose one another's field/header changes.
    let snapshot = db.provider_nodes().await.unwrap()[0].clone();
    let mut left = snapshot.clone(); left.revision += 1; left.name = "Concurrent left".into();
    let mut right = snapshot.clone(); right.revision += 2; right.name = "Concurrent right".into();
    let (a,b) = tokio::join!(db.upsert_provider_node(&left, Some(snapshot.revision)), db2.upsert_provider_node(&right, Some(snapshot.revision)));
    assert_ne!(a.is_ok(), b.is_ok());
    assert!(db.provider_nodes().await.unwrap()[0].header_config.is_some());
    assert_eq!(client.put(&headers_endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"headers":{}})).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(chat_model(&client, &base, CLIENT_KEY, "node-combo").await.status(), StatusCode::OK);
    assert!(seen.lock().unwrap().last().unwrap().2.is_none());
    assert!(db.provider_nodes().await.unwrap()[0].header_config.is_none());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            assert_eq!(chat_model(&client, &base2, CLIENT_KEY, "node-combo").await.status(), StatusCode::OK);
            if seen.lock().unwrap().last().unwrap().2.is_none() { break; }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }).await.expect("the other control plane retained removed shared headers");
    assert!(!format!("{:?}", db.audit_events(None).await.unwrap()).contains("shared-secret"));
    // Database ownership guards reject races that try to replace another tenant's definition.
    let original = db.provider_nodes().await.unwrap()[0].clone();
    let mut wrong_owner = original.clone(); wrong_owner.tenant_id = "other-company".into();
    assert!(db.upsert_provider_node(&wrong_owner, Some(original.revision)).await.is_err());
    assert_eq!(db.provider_nodes().await.unwrap()[0].tenant_id, "red");
    assert_eq!(client.delete(&combo_endpoint).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    for id in ["node-one", "node-two"] {
        assert_eq!(client.delete(format!("{base}/api/admin/providers/{id}")).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
        assert_eq!(client.delete(format!("{base}/api/admin/providers/{id}/purge")).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    }
    assert_eq!(client.delete(&endpoint).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    assert!(db.provider_nodes().await.unwrap().is_empty());
    assert!(db.upsert_provider_node(&original, Some(original.revision)).await.is_err());
    assert!(db.provider_nodes().await.unwrap().is_empty());
    gateway_task.abort(); task2.abort(); upstream_task.abort();
}
