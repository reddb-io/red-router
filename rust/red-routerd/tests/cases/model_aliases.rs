async fn alias_test_provider(
    key: &'static str,
    status: StatusCode,
) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let models = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = models.clone();
    let app = Router::new().route("/v1/chat/completions", post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
        let seen = seen.clone();
        async move {
            assert_eq!(headers["authorization"].to_str().unwrap(), format!("Bearer {key}"));
            seen.lock().unwrap().push(body["model"].as_str().unwrap().to_owned());
            if !status.is_success() { return (status, Json(serde_json::json!({"error":{"message":"quota exceeded"}}))).into_response(); }
            if body["stream"] == true {
                let frame = serde_json::json!({"model":body["model"],"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}});
                ([(header::CONTENT_TYPE,"text/event-stream")],format!("data: {frame}\n\ndata: [DONE]\n\n")).into_response()
            } else {
                Json(serde_json::json!({"model":body["model"],"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}})).into_response()
            }
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        format!("http://{address}/v1/chat/completions"),
        models,
        task,
    )
}

#[tokio::test]
async fn model_aliases_are_tenant_scoped_preserve_denials_quotas_and_restart() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("aliases.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let control = ControlPlane::new(
        Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap()),
        ADMIN_KEY,
        STORAGE_KEY,
        true,
    )
    .await
    .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (red, red_models, red_task) = alias_test_provider("alias-red-secret", StatusCode::OK).await;
    let (blue, blue_models, blue_task) =
        alias_test_provider("alias-blue-secret", StatusCode::OK).await;
    assert_eq!(
        client
            .put(format!("{base}/api/admin/tenants/blue"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"slug":"blue","name":"Blue"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for (id, tenant, upstream, credential) in [
        ("alias-red-account", "red", red, "alias-red-secret"),
        ("alias-blue-account", "blue", blue, "alias-blue-secret"),
    ] {
        assert_eq!(client.put(format!("{base}/api/admin/providers/{id}")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"tenant_id":tenant,"provider":"private-api","upstream_url":upstream,"api_key":credential})).send().await.unwrap().status(),StatusCode::OK);
    }
    let endpoint = format!("{base}/api/admin/model-aliases");
    let mut red_alias = serde_json::Value::Null;
    for tenant in ["red", "blue"] {
        let input = serde_json::json!({"tenant_id":tenant,"alias":"friendly","provider":"private-api","model":format!("upstream-{tenant}")});
        assert_eq!(
            client
                .post(&endpoint)
                .json(&input)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let response = client
            .post(&endpoint)
            .bearer_auth(ADMIN_KEY)
            .json(&input)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let record: serde_json::Value = response.json().await.unwrap();
        if tenant == "red" {
            red_alias = record["alias"].clone();
        }
    }
    let red_key = "alias-red-client-key-12345678901234567890";
    let blue_key = "alias-blue-client-key-12345678901234567890";
    let blocked_key = "alias-blocked-client-key-12345678901234567890";
    let quota_key = "alias-quota-client-key-12345678901234567890";
    let combo_only = "alias-combo-client-key-12345678901234567890";
    for (id, key, tenant, extra) in [
        ("alias-red-key", red_key, "red", serde_json::json!({})),
        ("alias-blue-key", blue_key, "blue", serde_json::json!({})),
        (
            "alias-blocked-key",
            blocked_key,
            "red",
            serde_json::json!({"blocked_models":["private-api/upstream-red"]}),
        ),
        (
            "alias-quota-key",
            quota_key,
            "red",
            serde_json::json!({"max_tokens_per_day":5,"reservation_tokens":5}),
        ),
        (
            "alias-combo-key",
            combo_only,
            "red",
            serde_json::json!({"allowed_models":[],"model_access_mode":"restricted","allowed_combos":["combo/*"]}),
        ),
    ] {
        let mut input = serde_json::json!({"label":id,"api_key":key,"tenant_id":tenant,"scopes":["inference:chat"],"allowed_models":["friendly"]});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let result = client
            .put(format!("{base}/api/admin/client-keys/{id}"))
            .bearer_auth(ADMIN_KEY)
            .json(&input)
            .send()
            .await
            .unwrap();
        assert_eq!(result.status(), StatusCode::OK);
    }
    for key in [red_key, blue_key] {
        let list: serde_json::Value = client
            .get(format!("{base}/v1/models"))
            .bearer_auth(key)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(list["data"].as_array().unwrap().len(), 1);
        assert_eq!(list["data"][0]["id"], "friendly");
        let result = chat_model(&client, &base, key, "friendly").await;
        assert_eq!(result.status(), StatusCode::OK);
        assert_eq!(
            result.json::<serde_json::Value>().await.unwrap()["model"],
            "friendly"
        );
    }
    assert_eq!(red_models.lock().unwrap().as_slice(), ["upstream-red"]);
    assert_eq!(blue_models.lock().unwrap().as_slice(), ["upstream-blue"]);
    for key in [blocked_key, combo_only] {
        assert_eq!(
            chat_model(&client, &base, key, "friendly").await.status(),
            StatusCode::FORBIDDEN
        );
        let list: serde_json::Value = client
            .get(format!("{base}/v1/models"))
            .bearer_auth(key)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(list["data"].as_array().unwrap().is_empty());
    }
    assert_eq!(
        chat_model(&client, &base, red_key, red_alias["id"].as_str().unwrap())
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        chat_model(&client, &base, quota_key, "friendly")
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        chat_model(&client, &base, quota_key, "friendly")
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    let replica_control = ControlPlane::new(
        Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap()),
        ADMIN_KEY,
        STORAGE_KEY,
        true,
    )
    .await
    .unwrap();
    let (replica, replica_task) = gateway(replica_control).await;
    let detail = format!("{endpoint}/{}", red_alias["id"].as_str().unwrap());
    let update = serde_json::json!({"alias":"friendly","provider":"private-api","model":"upstream-new","revision":red_alias["revision"]});
    let updated = client
        .put(&detail)
        .bearer_auth(ADMIN_KEY)
        .json(&update)
        .send()
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);
    let updated: serde_json::Value = updated.json().await.unwrap();
    assert_eq!(
        client
            .put(&detail)
            .bearer_auth(ADMIN_KEY)
            .json(&update)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let response = chat_model(&client, &replica, red_key, "friendly").await;
            assert_eq!(response.status(), StatusCode::OK);
            if red_models.lock().unwrap().last().map(String::as_str) == Some("upstream-new") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("alias target did not update in replica");
    let stream=chat_model_with_body(&client,&replica,red_key,serde_json::json!({"model":"friendly","messages":[],"stream":true,"stream_options":{"include_usage":true}})).await;
    assert_eq!(stream.status(), StatusCode::OK);
    let text = stream.text().await.unwrap();
    assert!(text.contains("\"model\":\"friendly\""));
    assert!(text.contains("[DONE]"));
    assert!(!text.contains("upstream-new"));
    assert_eq!(
        client
            .delete(format!(
                "{detail}?revision={}",
                red_alias["revision"].as_str().unwrap()
            ))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        client
            .delete(format!(
                "{detail}?revision={}",
                updated["alias"]["revision"].as_str().unwrap()
            ))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        chat_model(&client, &base, red_key, "friendly")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    // Remove the remaining organization alias as well. Restart must not restore raw passthrough.
    let rows: serde_json::Value = client
        .get(&endpoint)
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    for row in rows["aliases"].as_array().unwrap() {
        assert_eq!(
            client
                .delete(format!(
                    "{endpoint}/{}?revision={}",
                    row["id"].as_str().unwrap(),
                    row["revision"].as_str().unwrap()
                ))
                .bearer_auth(ADMIN_KEY)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    let restarted = ControlPlane::new(
        Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap()),
        ADMIN_KEY,
        STORAGE_KEY,
        true,
    )
    .await
    .unwrap();
    let (restarted, restarted_task) = gateway(restarted).await;
    assert_eq!(
        chat_model(&client, &restarted, red_key, "friendly")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    gateway_task.abort();
    replica_task.abort();
    restarted_task.abort();
    red_task.abort();
    blue_task.abort();
}

#[tokio::test]
async fn alias_account_pool_falls_back_beyond_the_fixed_combo_target_deck() {
    let db = Arc::new(
        Database::connect(Backend::Sqlite, "sqlite::memory:")
            .await
            .unwrap(),
    );
    let control = ControlPlane::new(db, ADMIN_KEY, STORAGE_KEY, true)
        .await
        .unwrap();
    let (base, task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (limited, limited_models, limited_task) =
        alias_test_provider("pool-secret", StatusCode::TOO_MANY_REQUESTS).await;
    let (healthy, healthy_models, healthy_task) =
        alias_test_provider("pool-secret", StatusCode::OK).await;
    for index in 0..9 {
        assert_eq!(client.put(format!("{base}/api/admin/providers/pool-{index:02}")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"provider":"pool-api","upstream_url":if index==8 {&healthy}else{&limited},"api_key":"pool-secret"})).send().await.unwrap().status(),StatusCode::OK);
    }
    let added=client.post(format!("{base}/api/admin/model-aliases")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"alias":"pool-model","provider":"pool-api","model":"real-pool-model"})).send().await.unwrap();
    assert_eq!(added.status(), StatusCode::OK);
    let result = chat_model(&client, &base, CLIENT_KEY, "pool-model").await;
    assert_eq!(result.status(), StatusCode::OK);
    assert_eq!(
        result.json::<serde_json::Value>().await.unwrap()["model"],
        "pool-model"
    );
    assert_eq!(limited_models.lock().unwrap().len(), 8);
    assert_eq!(
        healthy_models.lock().unwrap().as_slice(),
        ["real-pool-model"]
    );
    task.abort();
    limited_task.abort();
    healthy_task.abort();
}
