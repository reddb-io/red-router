#[tokio::test]
async fn staged_github_session_refreshes_copilot_and_preserves_exclusions() {
    let directory = TempDir::new().unwrap();
    let source = directory.path().join("github-legacy.sqlite");
    let destination = directory.path().join("github-native.sqlite");
    let source_url = format!("{}?mode=rwc", Url::from_file_path(&source).unwrap().as_str().replacen("file:", "sqlite:", 1));
    let dest_url = format!("{}?mode=rwc", Url::from_file_path(&destination).unwrap().as_str().replacen("file:", "sqlite:", 1));
    let source_db = sqlx::SqlitePool::connect(&source_url).await.unwrap();
    sqlx::raw_sql("CREATE TABLE provider_connections (id TEXT PRIMARY KEY,provider TEXT,auth_type TEXT,is_active INTEGER,tenant_id TEXT,name TEXT,display_name TEXT,email TEXT,access_token TEXT,refresh_token TEXT,id_token TEXT,provider_specific_data TEXT,project_id TEXT,token_type TEXT,scope TEXT,per_key_proxy_enabled INTEGER,proxy_enabled INTEGER,max_concurrent INTEGER,priority INTEGER,global_priority INTEGER,backoff_level INTEGER,rate_limit_protection INTEGER,quota_window_thresholds_json TEXT,rate_limit_overrides_json TEXT,rate_limited_until TEXT,default_model TEXT,\"group\" TEXT,api_key TEXT,test_status TEXT,error_code TEXT,last_error TEXT,last_error_type TEXT,last_error_source TEXT,expires_at TEXT,token_expires_at TEXT)")
        .execute(&source_db).await.unwrap();
    sqlx::query("INSERT INTO provider_connections (id,provider,auth_type,is_active,tenant_id,name,access_token,provider_specific_data) VALUES ('github-staged','github','oauth',1,'red','GitHub account','github-long-lived-token',?)")
        .bind(serde_json::json!({"autoSync":false,"copilotToken":"copilot-initial","copilotTokenExpiresAt":2000000000,"githubLogin":"fixture","excludedModels":["private-*"]}).to_string()).execute(&source_db).await.unwrap();
    source_db.close().await;
    Database::connect(Backend::Sqlite, &dest_url).await.unwrap().close().await.unwrap();
    red_routerd::legacy_providers::stage(&source, &destination, STORAGE_KEY).await.unwrap();
    let report = red_routerd::legacy_providers::adopt_github(&destination, "github-staged", STORAGE_KEY, STORAGE_KEY).await.unwrap();
    assert_eq!((report.imported, report.enabled, report.source_enabled), (1, false, true));
    let (token_endpoint, upstream, refreshes, inference, fixture_task) = github_copilot_fixture().await;
    assert_eq!(refreshes.load(Ordering::SeqCst), 0);
    let output = sqlx::SqlitePool::connect(&dest_url).await.unwrap();
    assert_eq!(sqlx::query("UPDATE redrouter_control_providers SET enabled=1,upstream_url=? WHERE id='github-staged' AND enabled=0")
        .bind(&upstream).execute(&output).await.unwrap().rows_affected(), 1);
    output.close().await;
    let db = Arc::new(Database::connect(Backend::Sqlite, &dest_url).await.unwrap());
    let session_before = db.provider_sessions().await.unwrap()[0].session_ciphertext.clone();
    let control = ControlPlane::new_with_oauth_refresh_endpoints(db.clone(), ADMIN_KEY, STORAGE_KEY, true, token_endpoint.clone(), token_endpoint).await.unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let response = client.post(format!("{base}/api/admin/providers/github-staged/oauth/refresh")).bearer_auth(ADMIN_KEY).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(db.provider_sessions().await.unwrap()[0].session_ciphertext, session_before);
    for (id, model) in [("github-allowed", "gpt-5.4"), ("github-blocked", "private-model")] {
        assert_eq!(client.put(format!("{base}/api/admin/combos/{id}")).bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"strategy":"priority","targets":[{"provider_id":"github-staged","model":model}]}))
            .send().await.unwrap().status(), StatusCode::OK);
    }
    assert_eq!(chat_model(&client, &base, CLIENT_KEY, "github-allowed").await.status(), StatusCode::OK);
    assert_ne!(chat_model(&client, &base, CLIENT_KEY, "github-blocked").await.status(), StatusCode::OK);
    assert_eq!(inference.load(Ordering::SeqCst), 1);
    gateway_task.abort(); fixture_task.abort();
}
