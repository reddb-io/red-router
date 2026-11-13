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
        assert_eq!(client.put(format!("{base}/api/admin/providers/pool-{index:02}")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"provider":"pool-api","upstream_url":if index==8 {&healthy}else{&limited},"api_key":"pool-secret","priority":index+1})).send().await.unwrap().status(),StatusCode::OK);
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

#[tokio::test]
async fn model_alias_uses_account_priority_and_preserves_it_after_restart() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("account-priority.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let control = ControlPlane::new(
        Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap()),
        ADMIN_KEY, STORAGE_KEY, true,
    ).await.unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (first_url, first_seen, first_task) = alias_test_provider("priority-first", StatusCode::OK).await;
    let (second_url, second_seen, second_task) = alias_test_provider("priority-second", StatusCode::OK).await;
    for (id, upstream, key, priority, default_model) in [
        ("a-account", &first_url, "priority-first", 20, "first-default"),
        ("z-account", &second_url, "priority-second", 1, "second-default"),
    ] {
        let response = client.put(format!("{base}/api/admin/providers/{id}"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"provider":"private-api","upstream_url":upstream,"api_key":key,"priority":priority,"default_model":default_model}))
            .send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.json::<serde_json::Value>().await.unwrap()["provider"]["priority"], priority);
    }
    let alias = client.post(format!("{base}/api/admin/model-aliases"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"alias":"friendly-priority","provider":"private-api","model":"target"}))
        .send().await.unwrap();
    assert_eq!(alias.status(), StatusCode::OK);
    let qualified = client.post(format!("{base}/api/admin/model-aliases"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"alias":"private-api/friendly-priority","provider":"private-api","model":"target"}))
        .send().await.unwrap();
    assert_eq!(qualified.status(), StatusCode::OK);
    let key = "priority-client-key-12345678901234567890";
    let created = client.put(format!("{base}/api/admin/client-keys/priority-key"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"label":"priority","api_key":key,"scopes":["inference:chat"],"allowed_models":["friendly-priority","private-api/friendly-priority"]}))
        .send().await.unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    assert_eq!(chat_model(&client, &base, key, "friendly-priority").await.status(), StatusCode::OK);
    assert_eq!(first_seen.lock().unwrap().len(), 0);
    assert_eq!(second_seen.lock().unwrap().as_slice(), ["second-default"]);
    assert_eq!(chat_model(&client, &base, key, "private-api/friendly-priority").await.status(), StatusCode::OK);
    assert_eq!(second_seen.lock().unwrap().as_slice(), ["second-default", "target"]);
    let restricted_key = "priority-blocked-key-12345678901234567890";
    let restricted = client.put(format!("{base}/api/admin/client-keys/priority-blocked"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"label":"blocked","api_key":restricted_key,"scopes":["inference:chat"],"allowed_models":["friendly-priority"],"blocked_models":["private-api/second-default","private-api/first-default"]}))
        .send().await.unwrap();
    assert_eq!(restricted.status(), StatusCode::OK);
    assert_eq!(chat_model(&client, &base, restricted_key, "friendly-priority").await.status(), StatusCode::FORBIDDEN);
    assert_eq!(second_seen.lock().unwrap().len(), 2);

    // Updating other connection metadata must retain priority and default model.
    let update = client.put(format!("{base}/api/admin/providers/z-account"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"provider":"private-api","upstream_url":&second_url,"label":"renamed"}))
        .send().await.unwrap();
    assert_eq!(update.status(), StatusCode::OK);
    let updated = update.json::<serde_json::Value>().await.unwrap();
    assert_eq!(updated["provider"]["priority"], 1);
    assert_eq!(updated["provider"]["default_model"], "second-default");
    let invalid = client.put(format!("{base}/api/admin/providers/z-account"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"provider":"private-api","upstream_url":&second_url,"priority":9007199254740992_i64}))
        .send().await.unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

    let replica = ControlPlane::new(
        Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap()),
        ADMIN_KEY, STORAGE_KEY, true,
    ).await.unwrap();
    let (replica_base, replica_task) = gateway(replica).await;
    assert_eq!(chat_model(&client, &replica_base, key, "friendly-priority").await.status(), StatusCode::OK);
    assert_eq!(first_seen.lock().unwrap().len(), 0);
    assert_eq!(second_seen.lock().unwrap().as_slice(), ["second-default", "target", "second-default"]);
    let change = client.put(format!("{base}/api/admin/providers/a-account"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"provider":"private-api","upstream_url":&first_url,"priority":0}))
        .send().await.unwrap();
    assert_eq!(change.status(), StatusCode::OK);
    let change = client.put(format!("{base}/api/admin/providers/z-account"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"provider":"private-api","upstream_url":&second_url,"priority":1000}))
        .send().await.unwrap();
    assert_eq!(change.status(), StatusCode::OK);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            assert_eq!(chat_model(&client, &replica_base, key, "friendly-priority").await.status(), StatusCode::OK);
            if !first_seen.lock().unwrap().is_empty() { break; }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }).await.unwrap();
    assert_eq!(first_seen.lock().unwrap().last().map(String::as_str), Some("first-default"));
    let clear = client.put(format!("{base}/api/admin/providers/a-account"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"provider":"private-api","upstream_url":&first_url,"default_model":null}))
        .send().await.unwrap();
    assert_eq!(clear.status(), StatusCode::OK);
    assert_eq!(chat_model(&client, &base, key, "friendly-priority").await.status(), StatusCode::OK);
    assert_eq!(first_seen.lock().unwrap().last().map(String::as_str), Some("target"));
    gateway_task.abort();
    replica_task.abort();
    first_task.abort();
    second_task.abort();
}

#[tokio::test]
async fn direct_provider_models_use_tenant_pools_priority_fallback_and_policies() {
    let dir = TempDir::new().unwrap();
    let file = Url::from_file_path(dir.path().join("direct-routing.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let control = ControlPlane::new(
        Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap()),
        ADMIN_KEY, STORAGE_KEY, true,
    ).await.unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (limited_url, limited_seen, limited_task) = alias_test_provider("direct-limited", StatusCode::TOO_MANY_REQUESTS).await;
    let (healthy_url, healthy_seen, healthy_task) = alias_test_provider("direct-healthy", StatusCode::OK).await;
    let (blue_url, blue_seen, blue_task) = alias_test_provider("direct-blue", StatusCode::OK).await;
    assert_eq!(client.put(format!("{base}/api/admin/tenants/blue")).bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"slug":"blue","name":"Blue"})).send().await.unwrap().status(), StatusCode::OK);
    for (id, tenant, upstream, credential, priority) in [
        ("direct-first", "red", &limited_url, "direct-limited", 1),
        ("direct-second", "red", &healthy_url, "direct-healthy", 2),
        ("direct-blue", "blue", &blue_url, "direct-blue", 1),
    ] {
        let result = client.put(format!("{base}/api/admin/providers/{id}"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"tenant_id":tenant,"provider":"private-api","upstream_url":upstream,"api_key":credential,"priority":priority}))
            .send().await.unwrap();
        assert_eq!(result.status(), StatusCode::OK);
    }
    let red_key = "direct-red-key-1234567890123456789012";
    let blue_key = "direct-blue-key-123456789012345678901";
    let restricted_key = "direct-restricted-key-12345678901234";
    for (id, key, tenant, allowed_provider_ids) in [
        ("direct-red-key", red_key, "red", Vec::<&str>::new()),
        ("direct-blue-key", blue_key, "blue", Vec::<&str>::new()),
        ("direct-restricted-key", restricted_key, "red", vec!["direct-second"]),
    ] {
        let result = client.put(format!("{base}/api/admin/client-keys/{id}"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"tenant_id":tenant,"label":id,"api_key":key,"scopes":["inference:chat"],"allowed_models":["private-api/model-1"],"allowed_provider_ids":allowed_provider_ids}))
            .send().await.unwrap();
        assert_eq!(result.status(), StatusCode::OK);
    }
    let result = chat_model(&client, &base, red_key, "private-api/model-1").await;
    assert_eq!(result.status(), StatusCode::OK);
    assert_eq!(limited_seen.lock().unwrap().as_slice(), ["model-1"]);
    assert_eq!(healthy_seen.lock().unwrap().as_slice(), ["model-1"]);
    assert!(blue_seen.lock().unwrap().is_empty());
    let result = chat_model(&client, &base, blue_key, "private-api/model-1").await;
    assert_eq!(result.status(), StatusCode::OK);
    assert_eq!(blue_seen.lock().unwrap().as_slice(), ["model-1"]);
    assert_eq!(chat_model(&client, &base, restricted_key, "private-api/model-1").await.status(), StatusCode::OK);
    assert_eq!(limited_seen.lock().unwrap().len(), 1);
    assert_eq!(healthy_seen.lock().unwrap().len(), 2);
    assert_eq!(chat_model(&client, &base, red_key, "private-api/other-model").await.status(), StatusCode::FORBIDDEN);
    let quota_key = "direct-quota-key-12345678901234567890";
    let quota = client.put(format!("{base}/api/admin/client-keys/direct-quota"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"tenant_id":"blue","label":"quota","api_key":quota_key,"scopes":["inference:chat"],"allowed_models":["private-api/model-1"],"max_tokens_per_day":5,"reservation_tokens":5}))
        .send().await.unwrap();
    assert_eq!(quota.status(), StatusCode::OK);
    assert_eq!(chat_model(&client, &base, quota_key, "private-api/model-1").await.status(), StatusCode::OK);
    assert_eq!(chat_model(&client, &base, quota_key, "private-api/model-1").await.status(), StatusCode::TOO_MANY_REQUESTS);

    // An unrelated configured alias must not disable direct provider routing.
    let alias = client.post(format!("{base}/api/admin/model-aliases")).bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"alias":"unrelated","provider":"private-api","model":"model-2"}))
        .send().await.unwrap();
    assert_eq!(alias.status(), StatusCode::OK);
    assert_eq!(chat_model(&client, &base, blue_key, "private-api/model-1").await.status(), StatusCode::OK);
    assert_eq!(blue_seen.lock().unwrap().len(), 3);
    let stream = chat_model_with_body(&client, &base, blue_key, serde_json::json!({"model":"private-api/model-1","messages":[],"stream":true,"stream_options":{"include_usage":true}})).await;
    assert_eq!(stream.status(), StatusCode::OK);
    assert!(stream.text().await.unwrap().contains("[DONE]"));
    assert_eq!(blue_seen.lock().unwrap().len(), 4);
    let requests = (0..32).map(|_| chat_model(&client, &base, blue_key, "private-api/model-1"));
    for response in futures_util::future::join_all(requests).await {
        assert_eq!(response.status(), StatusCode::OK);
    }
    assert_eq!(blue_seen.lock().unwrap().len(), 36);
    // Explicit aliases take precedence over interpreting the same name as
    // a direct provider/model request.
    let override_alias = client.post(format!("{base}/api/admin/model-aliases"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"alias":"private-api/model-1","provider":"private-api","model":"override-target"}))
        .send().await.unwrap();
    assert_eq!(override_alias.status(), StatusCode::OK);
    assert_eq!(chat_model(&client, &base, red_key, "private-api/model-1").await.status(), StatusCode::OK);
    assert_eq!(healthy_seen.lock().unwrap().last().map(String::as_str), Some("override-target"));
    let disabled_key = "direct-disabled-key-123456789012345";
    let created = client.put(format!("{base}/api/admin/client-keys/direct-disabled"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"tenant_id":"red","label":"disabled","api_key":disabled_key,"scopes":["inference:chat"],"allowed_models":["private-api/model-2"]}))
        .send().await.unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    for id in ["direct-first", "direct-second"] {
        assert_eq!(client.delete(format!("{base}/api/admin/providers/{id}")).bearer_auth(ADMIN_KEY).send().await.unwrap().status(), StatusCode::NO_CONTENT);
    }
    assert_eq!(chat_model(&client, &base, disabled_key, "private-api/model-2").await.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(blue_seen.lock().unwrap().len(), 36);
    gateway_task.abort(); limited_task.abort(); healthy_task.abort(); blue_task.abort();
}
