#[tokio::test]
async fn a_repeated_idempotency_key_replays_the_completed_response() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("idempotency.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let counted = counted.clone();
            async move {
                let call = counted.fetch_add(1, Ordering::SeqCst) + 1;
                axum::Json(serde_json::json!({
                    "id": format!("call-{call}"),
                    "object": "chat.completion",
                    "choices": [{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let upstream_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/idem-account"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"openai-compatible",
                "upstream_url":upstream_url,
                "api_key":"idem-secret"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/idem-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"priority",
                "fallback":true,
                "targets":[{"provider_id":"idem-account","model":"upstream-model"}]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/idem-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Idempotency client",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let send = |key: Option<&'static str>, content: &'static str| {
        let (client, base) = (client.clone(), base.clone());
        async move {
            let mut request = client
                .post(format!("{base}/v1/chat/completions"))
                .bearer_auth(RUST_CLIENT_KEY)
                .json(&serde_json::json!({
                    "model":"idem-combo",
                    "messages":[{"role":"user","content":content}]
                }));
            if let Some(key) = key {
                request = request.header("idempotency-key", key);
            }
            let response = request.send().await.unwrap();
            let replayed = response.headers().get("x-omniroute-idempotent").is_some();
            let status = response.status();
            let body: serde_json::Value = response.json().await.unwrap();
            (
                status,
                replayed,
                body["id"].as_str().unwrap_or_default().to_owned(),
            )
        }
    };

    let first = send(Some("retry-1"), "hello").await;
    assert_eq!((first.0, first.1), (StatusCode::OK, false));
    // The same key and request replays without a new upstream call.
    let second = send(Some("retry-1"), "hello").await;
    assert_eq!(second, (StatusCode::OK, true, first.2.clone()));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // A different request, a different key or no key reaches the upstream.
    send(Some("retry-1"), "other prompt").await;
    send(Some("retry-2"), "hello").await;
    send(None, "hello").await;
    assert_eq!(calls.load(Ordering::SeqCst), 4);

    gateway_task.abort();
    upstream_task.abort();
}
