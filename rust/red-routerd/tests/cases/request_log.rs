// Legacy `call_logs`: every upstream attempt of a request is logged, the
// attempts of one request share an id, and the served attempt shows the usage
// its ledger event settled.
#[tokio::test]
async fn every_attempt_of_a_request_is_logged_with_its_usage() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("request-log.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let app = Router::new()
        .route(
            "/bad/v1/chat/completions",
            post(|| async { (StatusCode::SERVICE_UNAVAILABLE, "overloaded") }),
        )
        .route(
            "/good/v1/chat/completions",
            post(|| async {
                Json(serde_json::json!({
                    "id":"chatcmpl-log","object":"chat.completion","created":1,"model":"upstream-model",
                    "choices":[{"index":0,"message":{"role":"assistant","content":"logged"},"finish_reason":"stop"}],
                    "usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}
                }))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (id, path) in [("bad", "bad"), ("good", "good")] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"openai-compatible",
                    "upstream_url":format!("http://{address}/{path}/v1/chat/completions"),
                    "api_key":format!("{id}-secret")
                }))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/logged-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"priority","fallback":true,
                "targets":[
                    {"provider_id":"bad","model":"upstream-model"},
                    {"provider_id":"good","model":"upstream-model"}
                ]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let issued: serde_json::Value = client
        .post(format!("{base}/api/admin/client-keys"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "label":"Logged client","scopes":["inference:chat"],
            "allowed_models":["logged-combo","upstream-model"],"allowed_provider_ids":["bad","good"],
            "max_tokens_per_day":1000,"reservation_tokens":10
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let key = issued["key"].as_str().unwrap().to_owned();
    let key_id = issued["client_key"]["id"].as_str().unwrap().to_owned();
    let response = chat_model(&client, &base, &key, "logged-combo").await;
    let status = response.status();
    let text = response.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{text}");
    assert!(text.contains("logged"), "{text}");

    let log = |query: &str| {
        let client = client.clone();
        let url = format!("{base}/api/admin/request-log{query}");
        async move {
            let response = client.get(url).bearer_auth(ADMIN_KEY).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            response.json::<serde_json::Value>().await.unwrap()
        }
    };
    // The rows are written off the response path.
    let page = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let page = log("").await;
            if page["requests"].as_array().unwrap().len() == 2
                && !page["requests"][0]["usage"].is_null()
            {
                break page;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("two logged attempts");
    let served = &page["requests"][0];
    let failed = &page["requests"][1];
    assert_eq!(served["request_id"], failed["request_id"]);
    assert!(served["request_id"].as_str().unwrap().starts_with("rq_"));
    assert_eq!(
        (failed["attempt"].as_i64(), served["attempt"].as_i64()),
        (Some(0), Some(1))
    );
    assert_eq!(failed["provider_id"], "bad");
    assert_eq!(failed["status"], 503);
    assert_eq!(failed["error"], "upstream_error");
    assert!(failed["usage"].is_null() || failed["usage"]["tokens_input"] == 0);
    assert_eq!(served["provider_id"], "good");
    assert_eq!(served["status"], 200);
    assert!(served["error"].is_null());
    assert_eq!(served["model"], "upstream-model");
    assert_eq!(served["requested_model"], "logged-combo");
    assert_eq!(served["protocol"], "chat");
    assert_eq!(served["key_id"], key_id.as_str());
    assert_eq!(served["tenant_id"], "red");
    assert_eq!(served["stream"], false);
    assert_eq!(served["usage"]["tokens_input"], 3);
    assert_eq!(served["usage"]["tokens_output"], 2);
    assert!(page["next_cursor"].is_null());

    // Filters and paging.
    let errors = log("?outcome=error").await;
    assert_eq!(errors["requests"].as_array().unwrap().len(), 1);
    assert_eq!(errors["requests"][0]["provider_id"], "bad");
    let request_id = served["request_id"].as_str().unwrap();
    assert_eq!(
        log(&format!("?request_id={request_id}")).await["requests"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let first = log("?limit=1").await;
    assert_eq!(first["requests"].as_array().unwrap().len(), 1);
    let cursor = first["next_cursor"].as_str().unwrap().to_owned();
    let second = log(&format!("?limit=1&cursor={cursor}")).await;
    assert_eq!(second["requests"][0]["provider_id"], "bad");
    assert_eq!(
        client
            .get(format!("{base}/api/admin/request-log?limit=0"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .get(format!("{base}/api/admin/request-log"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    gateway_task.abort();
    upstream_task.abort();
    database.close().await.unwrap();
}
