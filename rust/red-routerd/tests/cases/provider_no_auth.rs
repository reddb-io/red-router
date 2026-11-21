#[tokio::test]
async fn explicit_no_auth_providers_preserve_client_auth_and_work_after_sqlite_restart() {
    let dir = TempDir::new().unwrap();
    let file = Url::from_file_path(dir.path().join("no-auth.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(db.clone(), ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (base, gateway_task) = gateway(control).await;
    let observed = Arc::new(Mutex::new(Vec::<HeaderMap>::new()));
    let inference_headers = observed.clone();
    let model_headers = observed.clone();
    let app = Router::new()
        .route("/v1/chat/completions", post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
            let captured = inference_headers.clone();
            async move {
                captured.lock().unwrap().push(headers);
                if body["stream"].as_bool() == Some(true) {
                    return ([(header::CONTENT_TYPE, "text/event-stream")], "data: {\"id\":\"local\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"local reply\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"local\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\ndata: [DONE]\n\n").into_response();
                }
                Json(serde_json::json!({"id":"local","object":"chat.completion","model":body["model"],"choices":[{"index":0,"message":{"role":"assistant","content":"local reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})).into_response()
            }
        }))
        .route("/v1/models", get(move |headers: HeaderMap| {
            let captured = model_headers.clone();
            async move {
                captured.lock().unwrap().push(headers);
                Json(serde_json::json!({"data":[{"id":"local-model"}]}))
            }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
    let upstream_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let endpoint = format!("{base}/api/admin/providers/local-fixture");
    let mut input = serde_json::json!({"provider":"local-compatible","upstream_url":upstream,"auth_scheme":"none","label":"Local API"});
    assert_eq!(client.put(&endpoint).json(&input).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    for (field, value) in [("api_key", serde_json::json!("must-not-send")), ("expires_at_unix", serde_json::json!(4_000_000_000_u64)), ("credential_type", serde_json::json!("oauth"))] {
        let mut invalid = input.clone(); invalid[field] = value;
        assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&invalid).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
    }
    // An omitted or automatic auth scheme must still require credentials.
    let mut invalid = input.clone(); invalid["auth_scheme"] = "auto".into();
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&invalid).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
    let response = client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let view: serde_json::Value = response.json().await.unwrap();
    assert_eq!(view["provider"]["auth_scheme"], "none");
    assert_eq!(view["provider"]["has_credential"], false);
    assert!(db.providers().await.unwrap()[0].credential_ciphertext.starts_with("rr:v1:"));
    assert_eq!(chat_model(&client, &base, "invalid-client-key-123456789", "local-model").await.status(), StatusCode::UNAUTHORIZED);
    assert!(observed.lock().unwrap().is_empty());
    assert_eq!(chat_model(&client, &base, CLIENT_KEY, "local-model").await.status(), StatusCode::OK);
    let probe: serde_json::Value = client.post(format!("{endpoint}/test")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"model":"local-model"})).send().await.unwrap().json().await.unwrap();
    assert_eq!(probe["diagnostic"]["ok"], true);
    assert_eq!(client.post(format!("{endpoint}/discovery")).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(client.put(format!("{base}/api/admin/combos/local-combo")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"protocol":"openai","strategy":"priority","targets":[{"provider_id":"local-fixture","model":"local-model"}]})).send().await.unwrap().status(), StatusCode::OK);
    let response = chat_model_with_body(&client, &base, CLIENT_KEY, serde_json::json!({"model":"local-combo","stream":true,"messages":[]})).await;
    assert_eq!(response.status(), StatusCode::OK);
    let stream = response.text().await.unwrap();
    assert!(stream.contains("local reply") && stream.contains("[DONE]"));
    let control = ControlPlane::new(Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap()), ADMIN_KEY, STORAGE_KEY, true).await.unwrap();
    let (restarted, restart_task) = gateway(control).await;
    assert_eq!(chat_model(&client, &restarted, CLIENT_KEY, "local-combo").await.status(), StatusCode::OK);
    assert!(observed.lock().unwrap().len() >= 5);
    for headers in observed.lock().unwrap().iter() {
        for forbidden in ["authorization", "x-api-key", "x-goog-api-key", "cookie", "proxy-authorization"] {
            assert!(!headers.contains_key(forbidden), "unexpected {forbidden}");
        }
    }
    // Switching back to authenticated mode cannot reuse the encrypted empty value.
    input["auth_scheme"] = "bearer".into();
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
    input["api_key"] = "real-replacement-fixture".into();
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(chat_model(&client, &base, CLIENT_KEY, "local-combo").await.status(), StatusCode::OK);
    assert_eq!(observed.lock().unwrap().last().unwrap()["authorization"], "Bearer real-replacement-fixture");
    input["auth_scheme"] = "none".into(); input["api_key"] = "".into();
    assert_eq!(client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&input).send().await.unwrap().status(), StatusCode::OK);
    assert_eq!(chat_model(&client, &base, CLIENT_KEY, "local-combo").await.status(), StatusCode::OK);
    assert!(!observed.lock().unwrap().last().unwrap().contains_key("authorization"));
    gateway_task.abort(); restart_task.abort(); upstream_task.abort();
}
