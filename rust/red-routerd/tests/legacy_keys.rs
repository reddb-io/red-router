use red_routerd::{
    legacy_keys,
    storage::{Backend, Database},
};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::TempDir;
use url::Url;

#[tokio::test]
async fn imported_model_patterns_gate_catalog_and_dispatch_and_survive_dashboard_edits() {
    use axum::{routing::post, Json, Router};
    use red_routerd::{control_plane::ControlPlane, router, ProxyState};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let (_dir, source, dest, url) = fixture().await;
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::raw_sql(r#"
        UPDATE api_keys SET allowed_models='["openai/gpt-*","team"]',
          blocked_models='["openai/gpt-secret*"]', allowed_combos=NULL,
          allowed_connections='["models"]' WHERE id='first';
        INSERT INTO key_value VALUES ('settings','preferClaudeCodeForUnprefixedClaudeModels','true');
    "#).execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    let original = tokio::fs::read(&source).await.unwrap();
    legacy_keys::import(&source, &dest).await.unwrap();
    assert_eq!(original, tokio::fs::read(&source).await.unwrap());
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let mut key = db
        .client_keys()
        .await
        .unwrap()
        .into_iter()
        .find(|key| key.id == "first")
        .unwrap();
    assert!(!key.enabled);
    assert_eq!(key.allowed_combos_json, "null");
    assert_eq!(key.allowed_provider_ids_json, r#"["models"]"#);
    let grants: serde_json::Value = serde_json::from_str(&key.allowed_models_json).unwrap();
    assert_eq!(grants["schema"], "redrouter-model-permissions-v1");
    assert_eq!(grants["prefer_claude_code"], true);
    // Isolate authorization after activation; the importer itself never bypasses
    // the quota-adoption gate, covered separately by legacy_quota tests.
    key.enabled = true;
    db.upsert_client_key(&key).await.unwrap();
    db.close().await.unwrap();

    let calls = Arc::new(AtomicUsize::new(0));
    let upstream_calls = calls.clone();
    let upstream = Router::new().route("/v1/chat/completions", post(move || {
        let calls = upstream_calls.clone();
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Json(serde_json::json!({"id":"fixture","object":"chat.completion","model":"fixture",
                "choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_address = listener.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(
        database.clone(),
        "legacy-schedule-admin-key-00000001",
        "0123456789abcdef0123456789abcdef",
        true,
    )
    .await
    .unwrap();
    let state = ProxyState::new(
        "http://127.0.0.1:1/v1/chat/completions",
        "fallback-client-00000001",
        "placeholder",
        true,
    )
    .await
    .unwrap()
    .with_control_plane(control);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for id in ["models", "other-connection"] {
        let response = client.put(format!("{base}/api/admin/providers/{id}"))
        .bearer_auth("legacy-schedule-admin-key-00000001").header("content-type", "application/json")
        .body(serde_json::json!({"provider":"openai","upstream_url":format!("http://{upstream_address}/v1/chat/completions"),"api_key":"fixture-provider-key"}).to_string())
        .send().await.unwrap();
        assert_eq!(
            response.status().as_u16(),
            200,
            "{}",
            response.text().await.unwrap()
        );
    }
    for (combo, model, connection) in [
        ("allowed", "gpt-4o", "models"),
        ("denied", "gpt-secret-mini", "models"),
        ("team", "other", "models"),
        ("unlisted", "other", "models"),
        ("wrong-connection", "gpt-4o", "other-connection"),
    ] {
        let response = client.put(format!("{base}/api/admin/combos/{combo}"))
            .bearer_auth("legacy-schedule-admin-key-00000001").header("content-type", "application/json")
            .body(serde_json::json!({"protocol":"openai","strategy":"priority","fallback":true,"targets":[{"provider_id":connection,"model":model}]}).to_string())
            .send().await.unwrap();
        assert_eq!(
            response.status().as_u16(),
            200,
            "{}",
            response.text().await.unwrap()
        );
    }
    for (combo, expected) in [
        ("allowed", 200),
        ("denied", 403),
        ("team", 200),
        ("unlisted", 403),
        ("wrong-connection", 403),
    ] {
        let response = client.post(format!("{base}/v1/chat/completions"))
            .bearer_auth("secret-credential-123456").header("content-type","application/json")
            .body(serde_json::json!({"model":combo,"messages":[{"role":"user","content":"hello"}],"stream":false}).to_string())
            .send().await.unwrap();
        assert_eq!(
            response.status().as_u16(),
            expected,
            "{combo}: {}",
            response.text().await.unwrap()
        );
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "denied models must never reach the provider"
    );
    let response = client
        .get(format!("{base}/v1/models"))
        .bearer_auth("secret-credential-123456")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let catalog: serde_json::Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    let ids: Vec<_> = catalog["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["allowed", "team"]);

    // The dashboard submits normal arrays; the persisted matcher is retained by
    // the backend so editing a label cannot reinterpret existing glob rules.
    let response = client.put(format!("{base}/api/admin/client-keys/first"))
        .bearer_auth("legacy-schedule-admin-key-00000001").header("content-type","application/json")
        .body(serde_json::json!({"label":"Renamed","enabled":false,"expires_at_unix":1893456000_u64,
            "model_access_mode":"restricted","allowed_models":["openai/gpt-*","team"],"blocked_models":["openai/gpt-secret*"],"allowed_combos":null,"allowed_provider_ids":["models"]}).to_string())
        .send().await.unwrap();
    assert_eq!(
        response.status().as_u16(),
        200,
        "{}",
        response.text().await.unwrap()
    );
    let response = client.put(format!("{base}/api/admin/client-keys/second"))
        .bearer_auth("legacy-schedule-admin-key-00000001").header("content-type", "application/json")
        .body(serde_json::json!({"label":"New model restrictions","enabled":false,"allowed_models":["*"]}).to_string())
        .send().await.unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let edited: serde_json::Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(edited["client_key"]["model_matching"], "legacy-v1");
    assert_eq!(edited["client_key"]["model_access_mode"], "restricted");
    assert!(
        edited["client_key"]["allowed_combos"].is_null(),
        "adding restrictions must not inherit an artificial all-combos grant"
    );
    task.abort();
    let _ = task.await;
    upstream_task.abort();
    let _ = upstream_task.await;
    database.close().await.unwrap();
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let saved = db
        .client_keys()
        .await
        .unwrap()
        .into_iter()
        .find(|key| key.id == "first")
        .unwrap();
    assert_eq!(saved.label, "Renamed");
    assert_eq!(saved.allowed_models_json, key.allowed_models_json);
    assert_eq!(saved.blocked_models_json, key.blocked_models_json);
    assert_eq!(saved.allowed_combos_json, "null");
    assert_eq!(
        saved.allowed_provider_ids_json,
        key.allowed_provider_ids_json
    );
    db.close().await.unwrap();
}

pub async fn fixture() -> (TempDir, std::path::PathBuf, std::path::PathBuf, String) {
    let dir = TempDir::new().unwrap();
    let source = dir.path().join("legacy.sqlite");
    let dest = dir.path().join("rust.sqlite");
    let mut input = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql(r#"
        CREATE TABLE api_keys (
          id TEXT PRIMARY KEY, name TEXT, key TEXT, machine_id TEXT, created_at TEXT,
          allowed_models TEXT DEFAULT '[]', model_access_mode TEXT DEFAULT 'all', blocked_models TEXT,
          allowed_combos TEXT, no_log INTEGER DEFAULT 0, allowed_connections TEXT, auto_resolve INTEGER DEFAULT 0,
          is_active INTEGER DEFAULT 1, access_schedule TEXT, max_requests_per_day INTEGER,
          max_requests_per_minute INTEGER, throttle_delay_ms INTEGER, max_sessions INTEGER DEFAULT 0,
          revoked_at TEXT, expires_at TEXT, last_used_at TEXT, key_prefix TEXT, ip_allowlist TEXT, scopes TEXT,
          rate_limits TEXT, is_banned INTEGER DEFAULT 0, key_hash TEXT, proxy_id TEXT, allowed_endpoints TEXT,
          allowed_quotas TEXT DEFAULT '[]', stream_default_mode TEXT DEFAULT 'legacy', cache_default_mode TEXT DEFAULT 'legacy',
          disable_non_public_models INTEGER DEFAULT 0, allow_usage_command INTEGER DEFAULT 0,
          usage_limit_enabled INTEGER DEFAULT 0, daily_usage_limit_usd REAL, weekly_usage_limit_usd REAL,
          chaos_mode_enabled INTEGER DEFAULT 0, compression_enabled INTEGER DEFAULT 1,
          allow_auto_combos INTEGER DEFAULT 1, catalog_scope TEXT DEFAULT 'all', tenant_id TEXT DEFAULT 'red'
        );
        CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT, PRIMARY KEY(namespace,key));
        CREATE TABLE api_key_quota_limits (api_key_id TEXT PRIMARY KEY,tpm_limit INTEGER,rpm_limit INTEGER,monthly_amount_usd REAL);
        INSERT INTO api_key_quota_limits VALUES ('first',200,5,0.01);
        CREATE TABLE api_key_token_limits (
          id TEXT PRIMARY KEY, api_key_id TEXT NOT NULL, scope_type TEXT NOT NULL,
          scope_value TEXT NOT NULL DEFAULT '', token_limit INTEGER NOT NULL,
          reset_interval TEXT NOT NULL DEFAULT 'monthly', reset_time TEXT,
          enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE api_key_daily_token_limits (id TEXT);
        CREATE TABLE domain_budgets (id TEXT);
        CREATE TABLE budget_assignments (id TEXT);
        CREATE TABLE key_group_members (id TEXT);
        CREATE TABLE api_key_context_sources (id TEXT);
        CREATE TABLE api_key_usage_reservations (id TEXT);
        CREATE TABLE model_combo_mappings (id TEXT);
        INSERT INTO api_keys(id,name,key,allowed_combos,expires_at) VALUES
          ('first','Database A','secret-credential-123456','["combo/*"]','2030-01-01T00:00:00.000Z'),
          ('second','Database B','secret-credential-654321',NULL,NULL);
        UPDATE api_keys SET is_banned=1 WHERE id='second';
        INSERT INTO key_value VALUES ('api_key_id_format','first','flat'),('api_key_usage_attributes','first','{}');
    "#).execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    let file = Url::from_file_path(&dest).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    (dir, source, dest, url)
}

#[tokio::test]
async fn connection_grants_preserve_dangling_ids_and_invalid_later_keys_roll_back() {
    for (raw, expected) in [
        (
            r#"["missing-connection","noauth"]"#,
            Some(r#"["missing-connection","noauth"]"#),
        ),
        ("null", Some("[]")),
        ("[]", Some("[]")),
        (r#"["*"]"#, None),
        (r#"["connection",42]"#, None),
        (r#"{"connection":true}"#, None),
    ] {
        let (_dir, source, dest, url) = fixture().await;
        let mut input =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
                .await
                .unwrap();
        sqlx::query("UPDATE api_keys SET allowed_connections=? WHERE id='second'")
            .bind(raw)
            .execute(&mut input)
            .await
            .unwrap();
        input.close().await.unwrap();
        let before = tokio::fs::read(&source).await.unwrap();
        let result = legacy_keys::import(&source, &dest).await;
        assert_eq!(before, tokio::fs::read(&source).await.unwrap());
        let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
        let keys = db.client_keys().await.unwrap();
        if let Some(expected) = expected {
            result.unwrap();
            let key = keys.iter().find(|key| key.id == "second").unwrap();
            assert_eq!(key.allowed_provider_ids_json, expected);
            assert!(!key.enabled);
        } else {
            assert!(result.is_err());
            assert!(
                keys.is_empty(),
                "later invalid restriction must roll back earlier keys"
            );
        }
        db.close().await.unwrap();
    }
}

#[tokio::test]
async fn imports_unrestricted_keys_as_hashes_and_preserves_status_tenant_and_format() {
    use sha2::{Digest, Sha256};
    let (_dir, source, dest, url) = fixture().await;
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::raw_sql("INSERT INTO api_key_token_limits VALUES ('model-limit','first','model','gpt-4',500,'daily','00:00',1,datetime('now'),datetime('now'));")
        .execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    let before = tokio::fs::read(&source).await.unwrap();
    let report = legacy_keys::import(&source, &dest).await.unwrap();
    assert_eq!(
        (report.imported, report.disabled, report.source_enabled),
        (2, 2, 1)
    );
    assert_eq!(before, tokio::fs::read(&source).await.unwrap());
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let records = db.client_keys().await.unwrap();
    let first = records.iter().find(|key| key.id == "first").unwrap();
    assert_eq!(first.label, "Database A");
    assert_eq!(first.tenant_id, "red");
    assert_eq!(first.model_id_format, "flat");
    assert_eq!(first.expiry_unix, 1_893_456_000);
    assert!(!first.enabled);
    assert_eq!(
        first.key_hash,
        hex::encode(Sha256::digest(b"secret-credential-123456"))
    );
    assert!(
        !records
            .iter()
            .find(|key| key.id == "second")
            .unwrap()
            .enabled
    );
    assert!(!format!("{records:?}").contains("secret-credential"));
    db.close().await.unwrap();
    let mut target = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&dest))
        .await
        .unwrap();
    let status: (i64, i64, Option<String>) = sqlx::query_as("SELECT source_is_active,source_is_banned,source_revoked_at FROM redrouter_legacy_key_migration WHERE key_id='second'").fetch_one(&mut target).await.unwrap();
    assert_eq!(status, (1, 1, None));
    target.close().await.unwrap();
    assert!(
        legacy_keys::import(&source, &dest).await.is_err(),
        "must not overwrite existing keys"
    );
    assert!(legacy_keys::import(&source, &source).await.is_err());
}

#[tokio::test]
async fn any_unsupported_policy_rolls_back_all_keys_and_unknown_schema_fails_closed() {
    let (_dir, source, dest, url) = fixture().await;
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::query("UPDATE api_keys SET allowed_models='[42]' WHERE id='second'")
        .execute(&mut input)
        .await
        .unwrap();
    input.close().await.unwrap();
    assert!(legacy_keys::import(&source, &dest).await.is_err());
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert!(db.client_keys().await.unwrap().is_empty());
    db.close().await.unwrap();
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::raw_sql("UPDATE api_keys SET allowed_models='[]'; INSERT INTO api_key_token_limits VALUES ('limit','first','provider','openai',100,'daily','00:00',1,datetime('now'),datetime('now'));").execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    assert!(legacy_keys::import(&source, &dest).await.is_err());
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::raw_sql(
        "DELETE FROM api_key_token_limits; ALTER TABLE api_keys ADD COLUMN new_policy TEXT;",
    )
    .execute(&mut input)
    .await
    .unwrap();
    input.close().await.unwrap();
    assert!(legacy_keys::import(&source, &dest).await.is_err());
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert!(db.client_keys().await.unwrap().is_empty());
    db.close().await.unwrap();
}

#[tokio::test]
async fn imported_schedules_survive_storage_reload_and_gate_native_authentication() {
    use red_routerd::{control_plane::ControlPlane, router, ProxyState};
    use std::sync::Arc;
    for enabled in [true, false] {
        let (_dir, source, dest, url) = fixture().await;
        // Empty days is a valid legacy deny-all schedule, not an absent policy.
        let schedule = serde_json::json!({"enabled":enabled,"from":"22:00","until":"06:00","days":[],"tz":"America/Sao_Paulo"});
        let mut input =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
                .await
                .unwrap();
        sqlx::query("UPDATE api_keys SET access_schedule=? WHERE id='first'")
            .bind(schedule.to_string())
            .execute(&mut input)
            .await
            .unwrap();
        input.close().await.unwrap();
        let before = tokio::fs::read(&source).await.unwrap();
        legacy_keys::import(&source, &dest).await.unwrap();
        assert_eq!(before, tokio::fs::read(&source).await.unwrap());
        let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
        let keys = db.client_keys().await.unwrap();
        let first = keys.iter().find(|key| key.id == "first").unwrap();
        assert!(
            !first.enabled,
            "import does not activate a key before quota adoption"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&first.access_schedule_json).unwrap(),
            schedule
        );
        db.close().await.unwrap();
        // Isolate schedule enforcement after activation. Quota adoption is
        // covered by legacy_quota tests and is not bypassed by the importer.
        let mut target =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&dest))
                .await
                .unwrap();
        sqlx::query("UPDATE redrouter_control_client_keys SET enabled=1 WHERE id='first'")
            .execute(&mut target)
            .await
            .unwrap();
        target.close().await.unwrap();
        let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        let control = ControlPlane::new(
            database.clone(),
            "legacy-schedule-admin-key-00000001",
            "0123456789abcdef0123456789abcdef",
            true,
        )
        .await
        .unwrap();
        let state = ProxyState::new(
            "http://127.0.0.1:1/v1/chat/completions",
            "fallback-client-00000001",
            "placeholder",
            true,
        )
        .await
        .unwrap()
        .with_control_plane(control);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/v1/models"))
            .bearer_auth("secret-credential-123456")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), if enabled { 401 } else { 200 });
        task.abort();
        let _ = task.await;
        database.close().await.unwrap();
    }
}

#[tokio::test]
async fn malformed_schedule_rolls_back_preceding_keys_instead_of_dropping_the_restriction() {
    let valid = serde_json::json!({"enabled":true,"from":"08:00","until":"18:00","days":[1,2,3],"tz":"UTC"});
    for patch in [
        serde_json::json!({"tz":"Mars/Olympus"}),
        serde_json::json!({"from":"25:00"}),
        serde_json::json!({"days":[1,1]}),
        serde_json::json!({"days":[7]}),
        serde_json::json!({"enabled":"true"}),
        serde_json::json!({"futurePolicy":true}),
    ] {
        let (_dir, source, dest, url) = fixture().await;
        let mut invalid = valid.clone();
        invalid
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        let mut input =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
                .await
                .unwrap();
        sqlx::query("UPDATE api_keys SET access_schedule=CASE id WHEN 'first' THEN ? ELSE ? END")
            .bind(valid.to_string())
            .bind(invalid.to_string())
            .execute(&mut input)
            .await
            .unwrap();
        input.close().await.unwrap();
        assert!(legacy_keys::import(&source, &dest).await.is_err());
        let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
        assert!(db.client_keys().await.unwrap().is_empty());
        db.close().await.unwrap();
    }
}

#[tokio::test]
async fn restricted_empty_models_are_imported_without_granting_access() {
    for mode in ["restricted", "invalid-mode"] {
        let (_dir, source, dest, url) = fixture().await;
        let mut input =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
                .await
                .unwrap();
        sqlx::query("UPDATE api_keys SET model_access_mode=? WHERE id='second'")
            .bind(mode)
            .execute(&mut input)
            .await
            .unwrap();
        input.close().await.unwrap();
        let before = tokio::fs::read(&source).await.unwrap();
        let result = legacy_keys::import(&source, &dest).await;
        assert_eq!(before, tokio::fs::read(&source).await.unwrap());
        let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
        let keys = db.client_keys().await.unwrap();
        if mode == "restricted" {
            assert_eq!(result.unwrap().imported, 2);
            let key = keys.iter().find(|key| key.id == "second").unwrap();
            assert_eq!(key.model_access_mode, "restricted");
            let grants: serde_json::Value = serde_json::from_str(&key.allowed_models_json).unwrap();
            assert_eq!(grants["schema"], "redrouter-model-permissions-v1");
            assert_eq!(grants["patterns"], serde_json::json!([]));
            assert!(!key.enabled);
        } else {
            assert!(result.is_err());
            assert!(
                keys.is_empty(),
                "invalid second key must roll back the first key too"
            );
        }
        db.close().await.unwrap();
    }
}

#[tokio::test]
async fn combo_grants_migrate_independently_of_direct_model_access() {
    for (raw, expected) in [
        (None, Some(serde_json::Value::Null)),
        (Some("null"), Some(serde_json::Value::Null)),
        (Some("[]"), Some(serde_json::json!([]))),
        (Some(r#"["combo/*"]"#), Some(serde_json::json!(["combo/*"]))),
        (
            Some(r#"["combo/team","agents"]"#),
            Some(serde_json::json!(["combo/team", "agents"])),
        ),
        (Some(r#"["*"]"#), None),
    ] {
        let (_dir, source, dest, url) = fixture().await;
        let mut input =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
                .await
                .unwrap();
        sqlx::query("UPDATE api_keys SET model_access_mode='restricted', allowed_combos=? WHERE id='second'")
            .bind(raw).execute(&mut input).await.unwrap();
        input.close().await.unwrap();
        let before = tokio::fs::read(&source).await.unwrap();
        let result = legacy_keys::import(&source, &dest).await;
        assert_eq!(before, tokio::fs::read(&source).await.unwrap());
        let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
        let keys = db.client_keys().await.unwrap();
        if let Some(expected) = expected {
            result.unwrap();
            let key = keys.iter().find(|key| key.id == "second").unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&key.allowed_combos_json).unwrap(),
                expected
            );
            assert_eq!(key.model_access_mode, "restricted");
            assert!(!key.enabled);
        } else {
            assert!(result.is_err());
            assert!(keys.is_empty());
        }
        db.close().await.unwrap();
    }
}
