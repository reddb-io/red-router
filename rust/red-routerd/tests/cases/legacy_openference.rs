#[tokio::test]
async fn staged_openference_session_refreshes_and_routes_with_exclusions() {
    let directory = TempDir::new().unwrap();
    let source = directory.path().join("openference-legacy.sqlite");
    let destination = directory.path().join("openference-native.sqlite");
    let source_url = format!("{}?mode=rwc", Url::from_file_path(&source).unwrap().as_str().replacen("file:", "sqlite:", 1));
    let dest_url = format!("{}?mode=rwc", Url::from_file_path(&destination).unwrap().as_str().replacen("file:", "sqlite:", 1));
    let source_db = sqlx::SqlitePool::connect(&source_url).await.unwrap();
    sqlx::raw_sql("CREATE TABLE provider_connections (id TEXT PRIMARY KEY,provider TEXT,auth_type TEXT,is_active INTEGER,tenant_id TEXT,name TEXT,display_name TEXT,email TEXT,access_token TEXT,refresh_token TEXT,id_token TEXT,provider_specific_data TEXT,project_id TEXT,token_type TEXT,scope TEXT,per_key_proxy_enabled INTEGER,proxy_enabled INTEGER,max_concurrent INTEGER,priority INTEGER,global_priority INTEGER,backoff_level INTEGER,rate_limit_protection INTEGER,quota_window_thresholds_json TEXT,rate_limit_overrides_json TEXT,rate_limited_until TEXT,default_model TEXT,\"group\" TEXT,api_key TEXT,test_status TEXT,error_code TEXT,last_error TEXT,last_error_type TEXT,last_error_source TEXT,expires_at TEXT,token_expires_at TEXT)")
        .execute(&source_db).await.unwrap();
    sqlx::query("INSERT INTO provider_connections (id,provider,auth_type,is_active,tenant_id,name,access_token,refresh_token,id_token,provider_specific_data,expires_at) VALUES ('openference-staged','openference','oauth',1,'red','Openference account','openference-initial','openference-refresh','openference-identity',?,'2033-05-18T03:33:20Z')")
        .bind(serde_json::json!({"scope":"openid model:invoke offline_access","tokenType":"Bearer","excludedModels":["private-*"]}).to_string()).execute(&source_db).await.unwrap();
    source_db.close().await;
    Database::connect(Backend::Sqlite, &dest_url).await.unwrap().close().await.unwrap();
    red_routerd::legacy_providers::stage(&source, &destination, STORAGE_KEY).await.unwrap();
    let report = red_routerd::legacy_providers::adopt_openference(&destination, "openference-staged", STORAGE_KEY, STORAGE_KEY).await.unwrap();
    assert_eq!((report.imported, report.enabled, report.source_enabled), (1, false, true));
    let refreshes = Arc::new(AtomicUsize::new(0));
    let inference = Arc::new(AtomicUsize::new(0));
    let on_refresh = refreshes.clone();
    let on_inference = inference.clone();
    let app = Router::new().route("/openference-token", post(move |body: String| {
        let observed = on_refresh.clone(); async move {
            let fields: std::collections::HashMap<_, _> = url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
            assert_eq!(fields["client_id"], "omniroute"); assert_eq!(fields["refresh_token"], "openference-refresh");
            observed.fetch_add(1, Ordering::SeqCst);
            Json(serde_json::json!({"access_token":"openference-rotated","refresh_token":"openference-new-refresh","expires_in":3600,"token_type":"Bearer"}))
        }
    })).route("/v1/models", get(|headers: HeaderMap| async move {
        assert_eq!(headers[header::AUTHORIZATION], "Bearer openference-rotated");
        Json(serde_json::json!({"data":[{"id":"public-model","context_length":32768}]}))
    })).route("/v1/chat/completions", post(move |headers: HeaderMap| {
        let observed = on_inference.clone(); async move {
            assert_eq!(headers[header::AUTHORIZATION], "Bearer openference-rotated");
            observed.fetch_add(1, Ordering::SeqCst);
            Json(serde_json::json!({"id":"fixture","object":"chat.completion","model":"public-model","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let fixture_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let output = sqlx::SqlitePool::connect(&dest_url).await.unwrap();
    assert_eq!(sqlx::query("UPDATE redrouter_control_providers SET enabled=1,upstream_url=? WHERE id='openference-staged' AND enabled=0")
        .bind(format!("http://{address}/v1/chat/completions")).execute(&output).await.unwrap().rows_affected(), 1);
    output.close().await;
    let db = Arc::new(Database::connect(Backend::Sqlite, &dest_url).await.unwrap());
    let session_before = db.provider_sessions().await.unwrap()[0].session_ciphertext.clone();
    let token_endpoint = Url::parse(&format!("http://{address}/token")).unwrap();
    let control = ControlPlane::new_with_oauth_refresh_endpoints(db.clone(), ADMIN_KEY, STORAGE_KEY, true, token_endpoint.clone(), token_endpoint).await.unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let response = client.post(format!("{base}/api/admin/providers/openference-staged/oauth/refresh")).bearer_auth(ADMIN_KEY).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(db.provider_sessions().await.unwrap()[0].session_ciphertext, session_before);
    let discovery = format!("{base}/api/admin/providers/openference-staged/discovery");
    assert!(!client.put(&discovery).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"models_path":"/openference-token"})).send().await.unwrap().status().is_success());
    let response = client.post(&discovery).bearer_auth(ADMIN_KEY).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let discovered: serde_json::Value = response.json().await.unwrap();
    assert_eq!(discovered["models"][0]["id"], "public-model");
    assert_eq!(discovered["models"][0]["context_length"], 32768);
    for (id, model) in [("openference-allowed", "public-model"), ("openference-blocked", "private-model")] {
        assert_eq!(client.put(format!("{base}/api/admin/combos/{id}")).bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"strategy":"priority","targets":[{"provider_id":"openference-staged","model":model}]}))
            .send().await.unwrap().status(), StatusCode::OK);
    }
    assert_eq!(chat_model(&client, &base, CLIENT_KEY, "openference-allowed").await.status(), StatusCode::OK);
    assert_ne!(chat_model(&client, &base, CLIENT_KEY, "openference-blocked").await.status(), StatusCode::OK);
    assert_eq!(inference.load(Ordering::SeqCst), 1);
    gateway_task.abort(); fixture_task.abort();
}
