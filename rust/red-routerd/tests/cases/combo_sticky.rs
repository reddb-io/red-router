#[tokio::test]
async fn round_robin_combos_send_sticky_batches() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("combo-sticky.sqlite")).unwrap();
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
    let (a_url, a_task) = provider("sticky-a-secret", "a").await;
    let (b_url, b_task) = provider("sticky-b-secret", "b").await;
    for (id, upstream, credential) in [
        ("sticky-a", &a_url, "sticky-a-secret"),
        ("sticky-b", &b_url, "sticky-b-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"openai",
                    "upstream_url":upstream,
                    "api_key":credential
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
            .put(format!("{base}/api/admin/client-keys/sticky-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Sticky client",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["sticky-combo","upstream-model"],
                "allowed_provider_ids":["sticky-a","sticky-b"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/sticky-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"round-robin",
                "fallback":true,
                "targets":[
                    {"provider_id":"sticky-a","model":"upstream-model"},
                    {"provider_id":"sticky-b","model":"upstream-model"}
                ]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let picks = |count: usize| {
        let client = client.clone();
        let base = base.clone();
        async move {
            let mut picks = Vec::new();
            for _ in 0..count {
                let response = chat_model(&client, &base, RUST_CLIENT_KEY, "sticky-combo").await;
                assert_eq!(response.status(), StatusCode::OK);
                picks.push(response.text().await.unwrap());
            }
            picks
        }
    };
    let limit = |value: u32| {
        client
            .put(format!(
                "{base}/api/admin/global-settings/combo_sticky_round_robin_limit"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!(value))
            .send()
    };
    // The legacy default batch is the provider pools' limit of three.
    assert_eq!(picks(7).await, ["a", "a", "a", "b", "b", "b", "a"]);
    assert_eq!(limit(2).await.unwrap().status(), StatusCode::OK);
    // A settings change recompiles the routes, which starts the rotation
    // over (the legacy state, keyed by combo name, would survive it).
    assert_eq!(picks(5).await, ["a", "a", "b", "b", "a"]);
    // A limit of one rotates on every request.
    assert_eq!(limit(1).await.unwrap().status(), StatusCode::OK);
    assert_eq!(picks(3).await, ["a", "b", "a"]);
    assert_eq!(limit(0).await.unwrap().status(), StatusCode::BAD_REQUEST);

    gateway_task.abort();
    a_task.abort();
    b_task.abort();
}

#[tokio::test]
async fn combos_follow_prompt_cache_affinity_for_a_shared_prefix() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("combo-affinity.sqlite")).unwrap();
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
    let (a_url, a_task) = provider("affinity-a-secret", "a").await;
    let (b_url, b_task) = provider("affinity-b-secret", "b").await;
    for (id, upstream, credential) in [
        ("affinity-a", &a_url, "affinity-a-secret"),
        ("affinity-b", &b_url, "affinity-b-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"openai",
                    "upstream_url":upstream,
                    "api_key":credential
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
            .put(format!("{base}/api/admin/client-keys/affinity-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Affinity client",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["affinity-combo","upstream-model"],
                "allowed_provider_ids":["affinity-a","affinity-b"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/affinity-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"round-robin",
                "fallback":true,
                "targets":[
                    {"provider_id":"affinity-a","model":"upstream-model"},
                    {"provider_id":"affinity-b","model":"upstream-model"}
                ]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let picks = |count: usize, offset: usize| {
        let client = client.clone();
        let base = base.clone();
        async move {
            let mut picks = Vec::new();
            // A new first user message each time keeps session stickiness out.
            for index in 0..count {
                let response = chat_model_with_body(
                    &client,
                    &base,
                    RUST_CLIENT_KEY,
                    serde_json::json!({
                        "model":"affinity-combo",
                        "messages":[
                            {"role":"system","content":"You are the shared agent prompt."},
                            {"role":"user","content":format!("hello {}", index + offset)}
                        ]
                    }),
                )
                .await;
                assert_eq!(response.status(), StatusCode::OK);
                picks.push(response.text().await.unwrap());
            }
            picks
        }
    };
    // A shared system prompt keeps every request on one connection, where
    // the round-robin batches alone would rotate after three.
    let affine = picks(4, 0).await;
    assert!(affine.iter().all(|pick| pick == &affine[0]), "{affine:?}");
    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/global-settings/prompt_cache_affinity"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!(false))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(picks(4, 100).await, ["a", "a", "a", "b"]);

    gateway_task.abort();
    a_task.abort();
    b_task.abort();
}

#[tokio::test]
async fn a_combo_conversation_returns_to_its_connection() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("combo-session.sqlite")).unwrap();
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
    let (a_url, a_task) = provider("session-a-secret", "a").await;
    let (b_url, b_task) = provider("session-b-secret", "b").await;
    for (id, upstream, credential) in [
        ("session-a", &a_url, "session-a-secret"),
        ("session-b", &b_url, "session-b-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"openai",
                    "upstream_url":upstream,
                    "api_key":credential
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
            .put(format!("{base}/api/admin/client-keys/session-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Session client",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["session-combo","upstream-model"],
                "allowed_provider_ids":["session-a","session-b"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/session-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"round-robin",
                "fallback":true,
                "targets":[
                    {"provider_id":"session-a","model":"upstream-model"},
                    {"provider_id":"session-b","model":"upstream-model"}
                ]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let setting = |key: &'static str, value: serde_json::Value| {
        client
            .put(format!("{base}/api/admin/global-settings/{key}"))
            .bearer_auth(ADMIN_KEY)
            .json(&value)
            .send()
    };
    // Rotate on every request so only the stickiness can repeat a target.
    for (key, value) in [
        ("combo_sticky_round_robin_limit", serde_json::json!(1)),
        ("prompt_cache_affinity", serde_json::json!(false)),
    ] {
        assert_eq!(setting(key, value).await.unwrap().status(), StatusCode::OK);
    }
    let pick = |conversation: &'static str| {
        let client = client.clone();
        let base = base.clone();
        async move {
            let response = chat_model_with_body(
                &client,
                &base,
                RUST_CLIENT_KEY,
                serde_json::json!({
                    "model":"session-combo",
                    "messages":[{"role":"user","content":conversation}]
                }),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            response.text().await.unwrap()
        }
    };
    let first = pick("conversation one").await;
    assert_eq!(pick("conversation one").await, first);
    assert_eq!(pick("conversation one").await, first);
    // Another conversation takes the rotation and then keeps its own target.
    let second = pick("conversation two").await;
    assert_eq!(pick("conversation two").await, second);

    // Without stickiness, the same conversation rotates.
    assert_eq!(
        setting("session_stickiness", serde_json::json!(false))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let rotated = [
        pick("conversation one").await,
        pick("conversation one").await,
    ];
    assert_ne!(rotated[0], rotated[1]);

    gateway_task.abort();
    a_task.abort();
    b_task.abort();
}
