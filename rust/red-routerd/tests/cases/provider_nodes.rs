#[tokio::test]
async fn reusable_provider_definitions_keep_account_credentials_and_shared_transport_after_restart() {
    let dir = TempDir::new().unwrap();
    let file = Url::from_file_path(dir.path().join("nodes.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(db.clone(), ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base, gateway_task) = gateway(control).await;
    let seen = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let observed = seen.clone();
    let infer = post(move |headers: HeaderMap, uri: axum::http::Uri, Json(body): Json<serde_json::Value>| {
        let observed = observed.clone();
        async move {
            observed.lock().unwrap().push((uri.to_string(), headers["authorization"].to_str().unwrap().to_owned()));
            Json(serde_json::json!({"id":"node-fixture","object":"chat.completion","model":body["model"],"choices":[{"index":0,"message":{"role":"assistant","content":"node reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}))
        }
    });
    let app = Router::new().route("/v1/infer", infer.clone()).route("/v1/next", infer)
        .route("/v1/catalog", get(|headers: HeaderMap| async move {
            assert_eq!(headers["authorization"], "Bearer account-one-secret");
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
    let view: serde_json::Value = client.get(format!("{base}/api/admin/provider-nodes")).bearer_auth(ADMIN_KEY).send().await.unwrap().json().await.unwrap();
    assert_eq!(view["nodes"][0]["upstream_url"], format!("{upstream_base}/infer"));
    assert!(view["nodes"][0]["revision"].is_string());
    assert_eq!(client.put(format!("{base}/api/admin/provider-nodes/duplicate-prefix")).bearer_auth(ADMIN_KEY).json(&node).send().await.unwrap().status(), StatusCode::CONFLICT);
    for (id, key) in [("node-one", "account-one-secret"), ("node-two", "account-two-secret")] {
        let response = client.put(format!("{base}/api/admin/providers/{id}")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"node_id":"shared-gateway","api_key":key})).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let view: serde_json::Value = response.json().await.unwrap();
        assert_eq!(view["provider"]["node_id"], "shared-gateway");
        assert_eq!(view["provider"]["provider"], "company-gateway");
        assert!(!view.to_string().contains(key));
        let probe: serde_json::Value = client.post(format!("{base}/api/admin/providers/{id}/test")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"model":"node-model"})).send().await.unwrap().json().await.unwrap();
        assert_eq!(probe["diagnostic"]["ok"], true);
        assert_eq!(seen.lock().unwrap().last().unwrap().1, format!("Bearer {key}"));
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
    node["protocol"] = "anthropic".into();
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&node).send().await.unwrap().status(), StatusCode::CONFLICT);
    assert_eq!(db.provider_nodes().await.unwrap()[0].protocol, "openai");
    let db2 = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control2 = ControlPlane::new(db2, ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base2, task2) = gateway(control2).await;
    assert_eq!(chat_model(&client, &base2, CLIENT_KEY, "node-combo").await.status(), StatusCode::OK);
    assert_eq!(seen.lock().unwrap().last().unwrap().0, "/v1/next");
    // Database ownership guards reject races that try to replace another tenant's definition.
    let original = db.provider_nodes().await.unwrap()[0].clone();
    let mut wrong_owner = original.clone(); wrong_owner.tenant_id = "other-company".into();
    assert!(db.upsert_provider_node(&wrong_owner).await.is_err());
    assert_eq!(db.provider_nodes().await.unwrap()[0].tenant_id, "red");
    assert_eq!(client.delete(&combo_endpoint).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    for id in ["node-one", "node-two"] {
        assert_eq!(client.delete(format!("{base}/api/admin/providers/{id}")).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
        assert_eq!(client.delete(format!("{base}/api/admin/providers/{id}/purge")).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    }
    assert_eq!(client.delete(&endpoint).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    assert!(db.provider_nodes().await.unwrap().is_empty());
    gateway_task.abort(); task2.abort(); upstream_task.abort();
}
