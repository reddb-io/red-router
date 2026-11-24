#[tokio::test]
async fn explicit_provider_protocol_survives_restart_and_protects_existing_combos() {
    let dir = TempDir::new().unwrap();
    let file = Url::from_file_path(dir.path().join("protocol.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(db.clone(), ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base, gateway_task) = gateway(control).await;
    let requests = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let capture = requests.clone();
    let app = Router::new().route("/vendor/infer", post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
        let capture = capture.clone();
        async move {
            assert_eq!(headers["authorization"], "Bearer custom-provider-secret");
            assert_eq!(headers["x-project"], "custom-project");
            capture.lock().unwrap().push(body.clone());
            Json(serde_json::json!({"id":"fixture-completion","object":"chat.completion","model":body["model"],"choices":[{"index":0,"message":{"role":"assistant","content":"custom response"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/vendor/infer", listener.local_addr().unwrap());
    let upstream_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let endpoint = format!("{base}/api/admin/providers/custom-path");
    let mut input = serde_json::json!({"provider":"openai-compatible","upstream_url":upstream,"api_key":"custom-provider-secret","protocol":"auto"});
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
    for protocol in ["openai-to-anthropic", "antigravity", "unknown", ""] {
        input["protocol"] = protocol.into();
        assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
    }
    input["protocol"] = "openai".into();
    // An explicit protocol relaxes the path suffix only, never URL security.
    for invalid in [format!("{upstream}?key=secret"), format!("{upstream}#fragment"), upstream.replacen("http://", "http://user:password@", 1), "http://example.com/vendor/infer".to_owned()] {
        input["upstream_url"] = invalid.into();
        assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
    }
    assert!(db.providers().await.unwrap().is_empty());
    input["upstream_url"] = upstream.clone().into();
    let response = client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let view: serde_json::Value = response.json().await.unwrap();
    assert_eq!(view["provider"]["protocol"], "openai");
    assert!(!view.to_string().contains("custom-provider-secret"));
    assert_eq!(client.put(format!("{endpoint}/headers")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"headers":{"x-project":"custom-project"}})).send().await.unwrap().status(), StatusCode::OK);
    let direct = chat(&client, &base, CLIENT_KEY).await;
    assert_eq!(direct.status(), StatusCode::OK);
    assert!(direct.text().await.unwrap().contains("custom response"));
    let diagnostic: serde_json::Value = client.post(format!("{endpoint}/test")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"model":"probe-model"})).send().await.unwrap().json().await.unwrap();
    assert_eq!(diagnostic["diagnostic"]["ok"], true, "{diagnostic}");
    let combo_endpoint = format!("{base}/api/admin/combos/custom-combo");
    let combo = serde_json::json!({"protocol":"openai","strategy":"priority","targets":[{"provider_id":"custom-path","model":"upstream-model"}]});
    assert_eq!(client.put(&combo_endpoint).bearer_auth(ADMIN_KEY).json(&combo).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(chat_model(&client, &base, CLIENT_KEY, "custom-combo").await.status(), StatusCode::OK);
    assert_eq!(requests.lock().unwrap().last().unwrap()["model"], "upstream-model");
    // Old clients omit the new field. Metadata edits must keep the saved transport.
    input.as_object_mut().unwrap().remove("protocol");
    input["api_key"] = "".into();
    input["label"] = "Custom account renamed".into();
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(db.providers().await.unwrap()[0].protocol, "openai");
    assert_eq!(chat_model(&client, &base, CLIENT_KEY, "custom-combo").await.status(), StatusCode::OK);
    input["protocol"] = "anthropic".into();
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
    input["api_key"] = "custom-provider-secret".into();
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap().status(), StatusCode::CONFLICT);
    assert_eq!(db.providers().await.unwrap()[0].protocol, "openai");
    // PUT must not bypass the same enabled-combo protection as DELETE.
    input["enabled"] = false.into();
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap().status(), StatusCode::CONFLICT);
    assert!(db.providers().await.unwrap()[0].enabled);
    // A second process reconstructs the same custom transport and compiled headers.
    let db2 = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control2 = ControlPlane::new(db2, ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base2, gateway2_task) = gateway(control2).await;
    let restarted = chat_model(&client, &base2, CLIENT_KEY, "custom-combo").await;
    assert_eq!(restarted.status(), StatusCode::OK);
    assert!(restarted.text().await.unwrap().contains("custom response"));
    assert!(db.audit_events(None).await.unwrap().iter().any(|event| event.action == "provider.update"));
    assert_eq!(client.delete(&combo_endpoint).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    assert_eq!(client.delete(&endpoint).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    assert_eq!(db.providers().await.unwrap()[0].protocol, "openai");
    assert_eq!(client.delete(format!("{endpoint}/purge")).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    assert!(db.providers().await.unwrap().is_empty());
    gateway_task.abort(); gateway2_task.abort(); upstream_task.abort();
}
