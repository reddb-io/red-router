// Ported from the legacy GET /v1/me/status (src/app/api/v1/me/status/route.ts,
// src/lib/usage/apiKeySelfService.ts): a key holding `self:usage` reads its
// own period spend and tokens, a key without it is forbidden, and the
// self-service scopes do not restrict inference.
#[tokio::test]
async fn keys_with_self_usage_read_their_own_status() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("self-service.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (upstream_url, upstream_task) = provider("self-service-secret", "self-service-ok").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/self-service-provider"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"openai-compatible",
                "upstream_url":upstream_url,
                "api_key":"self-service-secret"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for (id, key, scopes) in [
        (
            "self-usage-key",
            RUST_CLIENT_KEY,
            serde_json::json!(["self:usage"]),
        ),
        (
            "plain-key",
            "plain-self-service-client-key",
            serde_json::json!([]),
        ),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/client-keys/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(
                    &serde_json::json!({"label":id, "api_key":key, "enabled":true, "scopes":scopes})
                )
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
            "{id}"
        );
    }

    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/self-service-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"priority",
                "targets":[{"provider_id":"self-service-provider","model":"some-model"}]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    // A self-service scope alone does not restrict inference.
    let chat = chat_model(&client, &base, RUST_CLIENT_KEY, "self-service-combo").await;
    assert_eq!(chat.status(), StatusCode::OK);

    let status = client
        .get(format!("{base}/v1/me/status"))
        .bearer_auth(RUST_CLIENT_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(status.status(), StatusCode::OK);
    let status: serde_json::Value = status.json().await.unwrap();
    assert_eq!(status["apiKey"]["id"], "self-usage-key");
    assert_eq!(status["usage"]["cost"]["currency"], "USD");
    assert_eq!(status["usage"]["cost"]["period"], "monthly");
    assert!(status["usage"]["tokens"]["totalTokens"].is_number());
    assert!(status.get("accountQuotas").is_none());

    let forbidden = client
        .get(format!("{base}/v1/me/status"))
        .bearer_auth("plain-self-service-client-key")
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    let unauthorized = client
        .get(format!("{base}/v1/me/status"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    gateway_task.abort();
    upstream_task.abort();
}

// Legacy manage-scope API keys reach the management API; a key without the
// scope does not.
#[tokio::test]
async fn manage_scope_keys_reach_the_management_api() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("manage-scope.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (id, key, scopes) in [
        (
            "manage-key",
            "manage-scope-client-key-0123456789",
            serde_json::json!(["manage", "self:usage"]),
        ),
        (
            "plain-key",
            "plain-scope-client-key-0123456789",
            serde_json::json!([]),
        ),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/client-keys/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(
                    &serde_json::json!({"label":id, "api_key":key, "enabled":true, "scopes":scopes})
                )
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
            "{id}"
        );
    }
    let managed = client
        .get(format!("{base}/api/admin/combos"))
        .bearer_auth("manage-scope-client-key-0123456789")
        .send()
        .await
        .unwrap();
    assert_eq!(managed.status(), StatusCode::OK);
    let refused = client
        .get(format!("{base}/api/admin/combos"))
        .bearer_auth("plain-scope-client-key-0123456789")
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);

    gateway_task.abort();
}
