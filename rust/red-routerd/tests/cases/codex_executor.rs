// Ported from tests/unit/executor-codex.test.ts, codex-client-headers.test.ts
// and codex-stream-false.test.ts: a Codex OAuth account is called the way the
// Codex CLI calls the ChatGPT backend, and a non-streaming client gets the
// event stream folded into one Responses object.
#[tokio::test]
async fn codex_accounts_get_cli_headers_shaped_bodies_and_folded_streams() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("codex-executor.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let seen: Arc<Mutex<Vec<(HeaderMap, serde_json::Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let observed = seen.clone();
    let app = Router::new().route(
        "/responses",
        post(move |headers: HeaderMap, body: Bytes| {
            let observed = observed.clone();
            async move {
                observed
                    .lock()
                    .unwrap()
                    .push((headers, serde_json::from_slice(&body).unwrap()));
                let events = concat!(
                    "event: response.created\n",
                    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_codex\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\"}}\n\n",
                    "event: response.output_text.delta\n",
                    "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"Hello\"}\n\n",
                    "event: response.completed\n",
                    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_codex\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.5\",\"created_at\":11,\"output\":[],\"usage\":{\"input_tokens\":3,\"output_tokens\":1,\"total_tokens\":4}}}\n\n"
                );
                ([(header::CONTENT_TYPE, "text/event-stream")], events)
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let token_endpoint = Url::parse(&format!("http://{address}/token")).unwrap();
    let control = ControlPlane::new_with_oauth_refresh_endpoints(
        database,
        ADMIN_KEY,
        STORAGE_KEY,
        false,
        token_endpoint.clone(),
        token_endpoint,
    )
    .await
    .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3_600;
    let id_token = unverified_jwt(serde_json::json!({
        "email":"codex@example.com",
        "sub":"codex-user",
        "exp":expiry,
        "https://api.openai.com/auth":{
            "chatgpt_account_id":"ws-codex",
            "chatgpt_user_id":"codex-user"
        }
    }));
    let access_token = unverified_jwt(serde_json::json!({"exp":expiry}));
    let imported = client
        .post(format!("{base}/api/providers/codex-auth/import"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "source":{"kind":"json","json":{
                "auth_mode":"chatgpt",
                "tokens":{
                    "id_token":id_token,
                    "access_token":access_token.clone(),
                    "refresh_token":"codex-refresh-secret"
                }
            }}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(imported.status(), StatusCode::OK);
    let imported: serde_json::Value = imported.json().await.unwrap();
    let provider_id = imported["connection"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/codex-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"label":"Codex", "api_key":RUST_CLIENT_KEY, "enabled":true}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let combo = client
        .put(format!("{base}/api/admin/combos/codex-combo"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "protocol":"openai-responses",
            "strategy":"priority",
            "targets":[{"provider_id":provider_id,"model":"gpt-5.5-high"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        combo.status(),
        StatusCode::OK,
        "{}",
        combo.text().await.unwrap()
    );

    let response = client
        .post(format!("{base}/v1/responses"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header(
            header::USER_AGENT,
            "codex_cli_rs/0.160.2 (Mac OS 26.6.2; arm64)",
        )
        .json(&serde_json::json!({
            "model":"codex-combo",
            "input":"hello",
            "max_output_tokens":5,
            "temperature":0.1
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("application/json"));
    let response: serde_json::Value = response.json().await.unwrap();
    assert_eq!(response["id"], "resp_codex");
    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "message");
    assert_eq!(response["output"][0]["content"][0]["text"], "Hello");
    assert_eq!(response["usage"]["total_tokens"], 4);

    let (headers, body) = seen.lock().unwrap()[0].clone();
    let header_value = |name: &str| headers[name].to_str().unwrap().to_owned();
    assert_eq!(
        header_value("authorization"),
        format!("Bearer {access_token}")
    );
    assert_eq!(header_value("chatgpt-account-id"), "ws-codex");
    assert_eq!(header_value("originator"), "codex_cli_rs");
    assert_eq!(header_value("version"), "0.160.2");
    assert_eq!(
        header_value("user-agent"),
        "codex-cli/0.160.2 (Windows 10.0.26200; x64)"
    );
    assert_eq!(header_value("session_id"), "ws-codex");
    assert_eq!(header_value("accept"), "text/event-stream");
    assert_eq!(body["model"], "gpt-5.5");
    assert_eq!(body["stream"], true);
    assert_eq!(body["store"], false);
    assert_eq!(
        body["instructions"],
        "Follow the developer instructions in the conversation."
    );
    assert_eq!(
        body["reasoning"],
        serde_json::json!({"effort":"high","summary":"auto"})
    );
    assert_eq!(
        body["include"],
        serde_json::json!(["reasoning.encrypted_content"])
    );
    assert_eq!(body["prompt_cache_key"], "ws-codex");
    assert_eq!(
        body["input"],
        serde_json::json!([{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}])
    );
    assert!(body.get("max_output_tokens").is_none());
    assert!(body.get("temperature").is_none());

    // A streaming client gets the upstream events as sent.
    let streamed = client
        .post(format!("{base}/v1/responses"))
        .bearer_auth(RUST_CLIENT_KEY)
        .json(&serde_json::json!({"model":"codex-combo","input":"hello","stream":true,"session_id":"conv-1"}))
        .send()
        .await
        .unwrap();
    assert_eq!(streamed.status(), StatusCode::OK);
    let streamed = streamed.text().await.unwrap();
    assert!(streamed.contains("event: response.completed"));
    let (headers, body) = seen.lock().unwrap()[1].clone();
    assert_eq!(headers["version"].to_str().unwrap(), "0.163.0");
    assert_eq!(body["prompt_cache_key"], "conv-1");
    assert!(body.get("session_id").is_none());

    // The global Codex service tier (legacy codexServiceTier) applies to a
    // Fast-eligible model.
    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/global-settings/codex_service_tier"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"enabled":true}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let tiered = client
        .post(format!("{base}/v1/responses"))
        .bearer_auth(RUST_CLIENT_KEY)
        .json(&serde_json::json!({"model":"codex-combo","input":"hello"}))
        .send()
        .await
        .unwrap();
    assert_eq!(tiered.status(), StatusCode::OK);
    let (_, body) = seen.lock().unwrap()[2].clone();
    assert_eq!(body["service_tier"], "priority");

    gateway_task.abort();
    upstream_task.abort();
}
