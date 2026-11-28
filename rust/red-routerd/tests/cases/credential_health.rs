// Legacy credentialHealth scheduler and credentialGate: a sweep probes each
// account's model listing, a failed credential is reported and cooled down,
// and combos skip it while the failure is fresh. An account's own cadence
// (legacy `healthCheckInterval`) paces it, and 0 leaves it out of the sweep.
#[tokio::test]
async fn a_failed_credential_probe_is_reported_and_combos_skip_the_account() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("credential-health.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let bad_chats = Arc::new(AtomicUsize::new(0));
    let bad_listings = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route(
            "/bad/v1/models",
            get({
                let listings = bad_listings.clone();
                move || async move {
                    listings.fetch_add(1, Ordering::SeqCst);
                    (StatusCode::UNAUTHORIZED, "invalid key")
                }
            }),
        )
        .route(
            "/bad/v1/chat/completions",
            post({
                let chats = bad_chats.clone();
                move || async move {
                    chats.fetch_add(1, Ordering::SeqCst);
                    (StatusCode::UNAUTHORIZED, "invalid key")
                }
            }),
        )
        .route(
            "/good/v1/models",
            get(|| async { Json(serde_json::json!({"object":"list","data":[]})) }),
        )
        .route(
            "/good/v1/chat/completions",
            post(|| async {
                Json(serde_json::json!({
                    "id":"chatcmpl-health","object":"chat.completion","created":1,"model":"upstream-model",
                    "choices":[{"index":0,"message":{"role":"assistant","content":"healthy"},"finish_reason":"stop"}],
                    "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
                }))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let put_provider = |id: &'static str, upstream: &'static str, interval: Option<i64>| {
        let client = client.clone();
        let url = format!("{base}/api/admin/providers/{id}");
        let mut body = serde_json::json!({
            "provider":"openai-compatible",
            "upstream_url":format!("http://{address}/{upstream}/v1/chat/completions"),
            "api_key":format!("{id}-secret")
        });
        if let Some(minutes) = interval {
            body["health_check_interval_minutes"] = serde_json::json!(minutes);
        }
        async move {
            client
                .put(url)
                .bearer_auth(ADMIN_KEY)
                .json(&body)
                .send()
                .await
                .unwrap()
        }
    };
    // More than a day is refused, as the legacy schema does.
    assert_eq!(
        put_provider("good", "good", Some(1_441)).await.status(),
        StatusCode::BAD_REQUEST
    );
    // "quiet" points at the failing upstream but is never probed.
    for (id, upstream, interval) in [
        ("bad", "bad", None),
        ("good", "good", Some(15)),
        ("quiet", "bad", Some(0)),
    ] {
        let response = put_provider(id, upstream, interval).await;
        assert_eq!(response.status(), StatusCode::OK);
        let view = response.json::<serde_json::Value>().await.unwrap();
        assert_eq!(
            view["provider"]["health_check_interval_minutes"],
            interval.map_or(serde_json::Value::Null, serde_json::Value::from)
        );
    }
    // An edit that leaves the cadence out keeps it.
    let kept = put_provider("good", "good", None).await;
    assert_eq!(kept.status(), StatusCode::OK);
    assert_eq!(
        kept.json::<serde_json::Value>().await.unwrap()["provider"]
            ["health_check_interval_minutes"],
        15
    );
    for (combo, targets) in [
        (
            "both",
            serde_json::json!([{"provider_id":"bad","model":"upstream-model"},{"provider_id":"good","model":"upstream-model"}]),
        ),
        (
            "only-bad",
            serde_json::json!([{"provider_id":"bad","model":"upstream-model"}]),
        ),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/combos/{combo}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({"strategy":"priority","fallback":true,"targets":targets}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    let issued: serde_json::Value = client
        .post(format!("{base}/api/admin/client-keys"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "label":"Health client","scopes":["inference:chat"],
            "allowed_models":["both","only-bad","upstream-model"],"allowed_provider_ids":["bad","good"]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let key = issued["key"].as_str().unwrap().to_owned();

    let health = || {
        let client = client.clone();
        let url = format!("{base}/api/admin/credential-health");
        async move {
            let response = client.get(url).bearer_auth(ADMIN_KEY).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            response.json::<serde_json::Value>().await.unwrap()
        }
    };
    // Nothing is known before the first sweep.
    assert_eq!(health().await["accounts"], serde_json::json!([]));
    let sweep = |token: &'static str| {
        let client = client.clone();
        let url = format!("{base}/api/admin/credential-health/sweep");
        async move { client.post(url).bearer_auth(token).send().await.unwrap() }
    };
    assert_eq!(sweep(CLIENT_KEY).await.status(), StatusCode::UNAUTHORIZED);
    let swept = sweep(ADMIN_KEY).await;
    assert_eq!(swept.status(), StatusCode::OK);
    assert_eq!(
        swept.json::<serde_json::Value>().await.unwrap()["probed"],
        2
    );
    assert_eq!(bad_listings.load(Ordering::SeqCst), 1);

    let report = health().await;
    assert_eq!(
        report["summary"],
        serde_json::json!({"total":2,"active":1,"error":1})
    );
    let bad = &report["accounts"][0];
    assert_eq!(bad["provider_id"], "bad");
    assert_eq!(bad["status"], "error");
    assert_eq!(bad["error_type"], "upstream_auth_error");
    assert_eq!(bad["last_error"], "Invalid API key");
    assert_eq!(bad["fresh"], true);
    assert_eq!(bad["consecutive_failures"], 1);
    let good = &report["accounts"][1];
    assert_eq!(good["provider_id"], "good");
    assert_eq!(good["status"], "active");
    assert!(good["last_error"].is_null());
    // A failure is retried after 5 minutes, a success after the interval.
    let checked = bad["checked_at_unix_ms"].as_u64().unwrap();
    assert_eq!(
        bad["next_check_at_unix_ms"].as_u64().unwrap(),
        checked + 300_000
    );
    // The healthy account follows its own 15-minute cadence.
    let good_next = good["next_check_at_unix_ms"].as_u64().unwrap()
        - good["checked_at_unix_ms"].as_u64().unwrap();
    assert!((800_000..=900_000).contains(&good_next), "{good_next}");
    // Legacy GET /api/monitoring/health: readiness for anyone, the cached
    // credential summary for an administrator.
    let monitoring = |token: Option<&'static str>| {
        let client = client.clone();
        let url = format!("{base}/api/monitoring/health");
        async move {
            let mut request = client.get(url);
            if let Some(token) = token {
                request = request.bearer_auth(token);
            }
            let response = request.send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            response.json::<serde_json::Value>().await.unwrap()
        }
    };
    assert_eq!(monitoring(None).await, serde_json::json!({"status":"ok"}));
    assert_eq!(
        monitoring(Some(CLIENT_KEY)).await,
        serde_json::json!({"status":"ok"})
    );
    let summary = &monitoring(Some(ADMIN_KEY)).await["credentialHealth"];
    assert_eq!(
        (
            &summary["total"],
            &summary["healthy"],
            &summary["failed"],
            &summary["stale"]
        ),
        (
            &serde_json::json!(2),
            &serde_json::json!(1),
            &serde_json::json!(1),
            &serde_json::json!(0)
        )
    );
    assert_eq!(
        summary["failedConnections"],
        serde_json::json!([{"connectionId":"bad","status":"error","lastError":"Invalid API key","lastErrorType":"upstream_auth_error"}])
    );
    assert!(summary.get("failedOmitted").is_none());
    // Nothing is due again yet.
    assert_eq!(
        sweep(ADMIN_KEY)
            .await
            .json::<serde_json::Value>()
            .await
            .unwrap()["probed"],
        0
    );
    assert_eq!(bad_listings.load(Ordering::SeqCst), 1);

    // The combo goes straight to the healthy account.
    let response = chat_model(&client, &base, &key, "both").await;
    let status = response.status();
    let text = response.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{text}");
    assert!(text.contains("healthy"), "{text}");
    assert_eq!(bad_chats.load(Ordering::SeqCst), 0);
    // With only the failed account left, the combo answers without trying it.
    let response = chat_model(&client, &base, &key, "only-bad").await;
    let status = response.status();
    let text = response.text().await.unwrap();
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{text}");
    assert!(text.contains("failed their health check"), "{text}");
    assert_eq!(bad_chats.load(Ordering::SeqCst), 0);
    gateway_task.abort();
    upstream_task.abort();
    database.close().await.unwrap();
}
