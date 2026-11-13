#[tokio::test]
async fn custom_provider_models_drive_scoped_discovery_and_metering_after_restart() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("custom-models.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(db.clone(), ADMIN_KEY, STORAGE_KEY, true)
        .await
        .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let (upstream, requests, provider_task) = usage_provider("custom-model-secret").await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(client.put(format!("{base}/api/admin/providers/custom-provider")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"provider":"private-api","upstream_url":upstream,"api_key":"custom-model-secret"})).send().await.unwrap().status(),StatusCode::OK);
    let endpoint = format!("{base}/api/admin/provider-models");
    let mut input = serde_json::json!({"provider":"private-api","metadata":{"id":"custom-model","name":"Private model","tool_call":true,"limit":{"context":4096,"input":2048,"output":128},"cost":{"input":1,"output":2}}});
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
    assert_eq!(
        client.get(&endpoint).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let created = client
        .post(&endpoint)
        .bearer_auth(ADMIN_KEY)
        .json(&input)
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let created: serde_json::Value = created.json().await.unwrap();
    let id = created["model"]["id"].as_str().unwrap();
    let revision = created["model"]["revision"].as_str().unwrap();
    let detail = format!("{endpoint}/{id}");
    assert_eq!(
        client.get(&detail).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(&endpoint)
            .bearer_auth(ADMIN_KEY)
            .json(&input)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    // A configured model and an eligible account now form a direct route.
    let listed: serde_json::Value = client
        .get(format!("{base}/v1/models"))
        .bearer_auth(CLIENT_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["data"][0]["id"], "private-api/custom-model");
    assert_eq!(listed["data"][0]["context_length"], 4096);
    assert_eq!(client.put(format!("{base}/api/admin/combos/custom-combo")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"protocol":"openai","strategy":"priority","targets":[{"provider_id":"custom-provider","model":"custom-model"}]})).send().await.unwrap().status(),StatusCode::OK);
    let key = "custom-model-client-key-1234567890";
    for (id, key, models) in [
        ("custom-client", key, vec!["custom-combo", "custom-model"]),
        (
            "custom-denied",
            "custom-denied-client-key-1234567890",
            vec!["other-model"],
        ),
    ] {
        let configured=client.put(format!("{base}/api/admin/client-keys/{id}")).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"label":id,"api_key":key,"scopes":["inference:chat"],"allowed_endpoints":["chat"],"allowed_models":models,"allowed_provider_ids":["custom-provider"],"max_spend_per_month_usd":1,"reservation_tokens":10,"reservation_spend_usd":0.001})).send().await.unwrap();
        assert_eq!(configured.status(), StatusCode::OK);
    }
    let read_models = |base: String| {
        let client = client.clone();
        async move {
            client
                .get(format!("{base}/v1/models"))
                .bearer_auth(key)
                .send()
                .await
                .unwrap()
                .json::<serde_json::Value>()
                .await
                .unwrap()
        }
    };
    let listed = read_models(base.clone()).await;
    assert_eq!(listed["data"][0]["context_length"], 4096);
    assert_eq!(listed["data"][0]["max_output_tokens"], 128);
    assert_eq!(listed["data"][0]["capabilities"]["tool_calling"], true);
    let denied: serde_json::Value = client
        .get(format!("{base}/v1/models"))
        .bearer_auth("custom-denied-client-key-1234567890")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(denied["data"].as_array().unwrap().is_empty());
    assert_eq!(
        chat_model(&client, &base, key, "custom-combo")
            .await
            .status(),
        StatusCode::OK
    );
    let control = ControlPlane::new(
        Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap()),
        ADMIN_KEY,
        STORAGE_KEY,
        true,
    )
    .await
    .unwrap();
    let (replica, replica_task) = gateway(control).await;
    assert_eq!(
        read_models(replica.clone()).await["data"][0]["context_length"],
        4096
    );
    input["revision"] = revision.into();
    let mut invalid = input.clone();
    invalid["metadata"]["cost"]["input"] = (-1).into();
    assert_eq!(
        client
            .put(&detail)
            .bearer_auth(ADMIN_KEY)
            .json(&invalid)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    input["metadata"]["limit"]["context"] = 8192.into();
    input["metadata"]["cost"] = serde_json::json!({"input":2,"output":4});
    let updated = client
        .put(&detail)
        .bearer_auth(ADMIN_KEY)
        .json(&input)
        .send()
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);
    let updated: serde_json::Value = updated.json().await.unwrap();
    assert_eq!(
        client
            .put(&detail)
            .bearer_auth(ADMIN_KEY)
            .json(&input)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        client
            .delete(format!("{detail}?revision={revision}"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if read_models(replica.clone()).await["data"][0]["context_length"] == 8192 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("custom model update did not reach the other proxy");
    let streamed=chat_model_with_body(&client,&replica,key,serde_json::json!({"model":"custom-combo","messages":[],"stream":true,"stream_options":{"include_usage":true}})).await;
    assert_eq!(streamed.status(), StatusCode::OK);
    assert!(streamed.text().await.unwrap().contains("[DONE]"));
    let pool = sqlx::SqlitePool::connect(&url).await.unwrap();
    let amounts:Vec<i64>=sqlx::query_scalar("SELECT amount_microusd FROM redrouter_usage_ledger WHERE key_id='custom-client' ORDER BY created_at_unix_ms").fetch_all(&pool).await.unwrap();
    assert_eq!(amounts, vec![7, 14]);
    let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_usage_reservations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(pending, 0);
    let revision = updated["model"]["revision"].as_str().unwrap();
    assert_eq!(
        client
            .delete(format!("{detail}?revision={revision}"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .get(&detail)
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    // Deleting a price override never retroactively reprices the ledger. A budgeted
    // request with no known catalog price must fail before reaching the provider.
    assert_eq!(
        chat_model(&client, &base, key, "custom-combo")
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT SUM(amount_microusd) FROM redrouter_usage_ledger WHERE key_id='custom-client'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        21
    );
    pool.close().await;
    gateway_task.abort();
    replica_task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn direct_model_discovery_respects_tenants_accounts_denials_and_alias_precedence() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("direct-discovery.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let control = ControlPlane::new(
        Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap()),
        ADMIN_KEY,
        STORAGE_KEY,
        true,
    ).await.unwrap();
    let (base, task) = gateway(control).await;
    let (upstream, _, provider_task) = usage_provider("discovery-secret").await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(client.put(format!("{base}/api/admin/tenants/blue")).bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"slug":"blue","name":"Blue"})).send().await.unwrap().status(), StatusCode::OK);
    for (id, tenant) in [("discovery-red", "red"), ("discovery-blue", "blue")] {
        assert_eq!(client.put(format!("{base}/api/admin/providers/{id}")).bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"tenant_id":tenant,"provider":"private-api","upstream_url":upstream,"api_key":"discovery-secret"}))
            .send().await.unwrap().status(), StatusCode::OK);
        assert_eq!(client.post(format!("{base}/api/admin/provider-models")).bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"tenant_id":tenant,"provider":"private-api","metadata":{"id":format!("model-{tenant}"),"limit":{"context":4096}}}))
            .send().await.unwrap().status(), StatusCode::OK);
    }
    assert_eq!(client.post(format!("{base}/api/admin/provider-models")).bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"provider":"unused-api","metadata":{"id":"orphan"}}))
        .send().await.unwrap().status(), StatusCode::OK);
    let red_key = "direct-discovery-red-key-1234567890";
    let blue_key = "direct-discovery-blue-key-1234567890";
    let blocked_key = "direct-discovery-blocked-key-1234567890";
    let other_account_key = "direct-discovery-account-key-1234567890";
    let no_chat_key = "direct-discovery-no-chat-key-1234567890";
    for (id, key, tenant, extra) in [
        ("discover-red", red_key, "red", serde_json::json!({})),
        ("discover-blue", blue_key, "blue", serde_json::json!({})),
        ("discover-blocked", blocked_key, "red", serde_json::json!({"blocked_models":["private-api/model-red"]})),
        ("discover-account", other_account_key, "red", serde_json::json!({"allowed_provider_ids":["discovery-blue"]})),
        ("discover-no-chat", no_chat_key, "red", serde_json::json!({"allowed_endpoints":["embeddings"]})),
    ] {
        let mut input = serde_json::json!({"tenant_id":tenant,"label":id,"api_key":key,"scopes":["inference:chat"]});
        input.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        assert_eq!(client.put(format!("{base}/api/admin/client-keys/{id}")).bearer_auth(ADMIN_KEY)
            .json(&input).send().await.unwrap().status(), StatusCode::OK);
    }
    for (key, expected) in [(red_key, Some("private-api/model-red")), (blue_key, Some("private-api/model-blue")), (blocked_key, None), (other_account_key, None), (no_chat_key, None)] {
        let response = client.get(format!("{base}/v1/models")).bearer_auth(key).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        let ids: Vec<_> = body["data"].as_array().unwrap().iter().filter_map(|row| row["id"].as_str()).collect();
        assert_eq!(ids, expected.into_iter().collect::<Vec<_>>());
    }
    assert_eq!(chat_model(&client, &base, red_key, "private-api/model-red").await.status(), StatusCode::OK);
    // A disabled alias shadows direct dispatch, so it must not be advertised as direct.
    assert_eq!(client.post(format!("{base}/api/admin/model-aliases")).bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"alias":"private-api/model-red","provider":"private-api","model":"elsewhere","enabled":false}))
        .send().await.unwrap().status(), StatusCode::OK);
    let listed: serde_json::Value = client.get(format!("{base}/v1/models")).bearer_auth(red_key)
        .send().await.unwrap().json().await.unwrap();
    assert!(listed["data"].as_array().unwrap().is_empty());
    assert_ne!(chat_model(&client, &base, red_key, "private-api/model-red").await.status(), StatusCode::OK);
    assert_eq!(client.delete(format!("{base}/api/admin/providers/discovery-blue")).bearer_auth(ADMIN_KEY)
        .send().await.unwrap().status(), StatusCode::NO_CONTENT);
    let listed: serde_json::Value = client.get(format!("{base}/v1/models")).bearer_auth(blue_key)
        .send().await.unwrap().json().await.unwrap();
    assert!(listed["data"].as_array().unwrap().is_empty());
    task.abort();
    provider_task.abort();
}
