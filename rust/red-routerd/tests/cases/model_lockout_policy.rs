// Ported from tests/unit/model-lockout-max-cooldown.test.ts and
// combo-model-lockout-honors-reset-1308.test.ts: with the legacy opt-in
// modelLockout policy on, a combo target failing with a configured status
// locks its model for the policy's base cooldown, and the combo moves on.
#[tokio::test]
async fn the_opt_in_model_lockout_policy_locks_failing_combo_models() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("lockout-policy.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (scoped_url, missing_requests, missing_status, _missing_body, scoped_task) =
        model_scoped_provider("policy-scoped-secret").await;
    missing_status.store(503, Ordering::SeqCst);
    let (fallback_url, fallback_task) = provider("policy-fallback-secret", "fallback-ok").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (id, upstream_url, api_key) in [
        ("policy-scoped", scoped_url, "policy-scoped-secret"),
        ("policy-fallback", fallback_url, "policy-fallback-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"openai-compatible",
                    "upstream_url":upstream_url,
                    "api_key":api_key,
                    "rate_limit_scope":"model"
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
            .put(format!("{base}/api/admin/client-keys/policy-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Lockout policy client",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["policy-combo","missing-model","working-model"],
                "allowed_provider_ids":["policy-scoped","policy-fallback"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/policy-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"priority",
                "fallback":true,
                "targets":[
                    {"provider_id":"policy-scoped","model":"missing-model"},
                    {"provider_id":"policy-fallback","model":"working-model"}
                ]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/global-settings/model_lockout_policy"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"enabled":true,"error_codes":[503]}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/global-settings/model_lockout_policy"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"enabled":true,"error_codes":[700]}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );

    for _ in 0..2 {
        assert_eq!(
            chat_model(&client, &base, RUST_CLIENT_KEY, "policy-combo")
                .await
                .text()
                .await
                .unwrap(),
            "fallback-ok"
        );
    }
    // The locked model is skipped on the second request.
    assert_eq!(missing_requests.load(Ordering::SeqCst), 1);
    let health: serde_json::Value = client
        .get(format!("{base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scoped = health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "policy-scoped")
        .unwrap();
    let lockout = &scoped["model_lockouts"][0];
    assert_eq!(lockout["model"], "missing-model");
    assert_eq!(lockout["status"], 503);
    // The policy base (two minutes), not the native 30-second model step.
    let retry_after = lockout["retry_after_ms"].as_u64().unwrap();
    assert!((100_000..=120_000).contains(&retry_after), "{retry_after}");

    gateway_task.abort();
    scoped_task.abort();
    fallback_task.abort();
}
