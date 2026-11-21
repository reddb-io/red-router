// Ported from tests/unit/credential-masker-guardrail.test.ts: with the legacy
// credentialRedactionEnabled guardrail on, a credential in the request never
// reaches the upstream and one in the answer never reaches the client.
#[tokio::test]
async fn the_credential_masker_redacts_requests_and_answers() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("credential-masker.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let leaked = format!("sk-proj-{}", "b".repeat(30));
    let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let observed = seen.clone();
    let answer = leaked.clone();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |Json(body): Json<serde_json::Value>| {
            let observed = observed.clone();
            let answer = answer.clone();
            async move {
                observed.lock().unwrap().push(body);
                Json(serde_json::json!({
                    "id":"chat-1",
                    "object":"chat.completion",
                    "model":"masked-model",
                    "choices":[{"index":0,"message":{"role":"assistant","content":format!("here: {answer}")},"finish_reason":"stop"}],
                    "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/masked"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"openai-compatible",
                "upstream_url":format!("http://{address}/v1/chat/completions"),
                "api_key":"masked-secret"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/masked-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"label":"Masked", "api_key":RUST_CLIENT_KEY, "enabled":true}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/masked-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"priority",
                "targets":[{"provider_id":"masked","model":"masked-model"}]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let ask = || {
        client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth(RUST_CLIENT_KEY)
            .json(&serde_json::json!({
                "model":"masked-combo",
                "messages":[{"role":"user","content":format!("my key is {leaked}")}]
            }))
            .send()
    };

    // Off by default: the text passes through.
    let plain: serde_json::Value = ask().await.unwrap().json().await.unwrap();
    assert!(plain["choices"][0]["message"]["content"]
        .as_str()
        .unwrap()
        .contains(&leaked));
    assert!(seen.lock().unwrap()[0].to_string().contains(&leaked));

    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/global-settings/credential_redaction"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!(true))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let masked = ask().await.unwrap();
    assert_eq!(masked.status(), StatusCode::OK);
    let masked: serde_json::Value = masked.json().await.unwrap();
    assert_eq!(
        masked["choices"][0]["message"]["content"],
        "here: [REDACTED:openai]"
    );
    let sent = seen.lock().unwrap()[1].clone();
    assert_eq!(
        sent["messages"][0]["content"],
        "my key is [REDACTED:openai]"
    );

    gateway_task.abort();
    upstream_task.abort();
}
