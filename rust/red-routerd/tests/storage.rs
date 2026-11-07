use red_routerd::storage::{Backend, Database, StoredClientKey, StoredCombo, StoredProvider};
use tempfile::TempDir;
use url::Url;

async fn exercise(backend: Backend, url: &str) {
    let db = Database::connect(backend, url).await.unwrap();
    assert_eq!(db.upstream().await.unwrap(), None);
    db.seed("https://first.example/v1/chat/completions")
        .await
        .unwrap();
    db.seed("https://ignored.example/v1/chat/completions")
        .await
        .unwrap();
    assert_eq!(
        db.upstream().await.unwrap().as_deref(),
        Some("https://first.example/v1/chat/completions")
    );
    db.set_upstream("https://second.example/v1/chat/completions")
        .await
        .unwrap();
    let first = StoredProvider {
        id: "first".into(),
        provider: "openai".into(),
        upstream_url: "https://first.example/v1/chat/completions".into(),
        credential_ciphertext: "encrypted-first".into(),
        enabled: true,
        updated_at: 1,
    };
    let mut second = StoredProvider {
        id: "second".into(),
        provider: "openrouter".into(),
        upstream_url: "https://second.example/v1/chat/completions".into(),
        credential_ciphertext: "encrypted-second".into(),
        enabled: false,
        updated_at: 2,
    };
    db.upsert_provider(&first).await.unwrap();
    db.upsert_provider(&second).await.unwrap();
    assert_eq!(
        db.providers().await.unwrap(),
        vec![second.clone(), first.clone()]
    );
    assert_eq!(db.active_provider().await.unwrap(), Some(first.clone()));
    second.enabled = true;
    second.updated_at = 3;
    db.upsert_provider(&second).await.unwrap();
    assert_eq!(db.active_provider().await.unwrap(), Some(second.clone()));
    db.disable_provider("second", 4).await.unwrap();
    assert_eq!(db.active_provider().await.unwrap(), Some(first.clone()));
    let client_key = StoredClientKey {
        id: "agent-fleet".into(),
        label: "Agent fleet".into(),
        key_hash: "11".repeat(32),
        enabled: true,
        expiry_unix: 2_000_000_000,
        scopes_json: r#"["inference:chat"]"#.into(),
        allowed_endpoints_json: r#"["chat"]"#.into(),
        allowed_models_json: r#"["openai/*"]"#.into(),
        blocked_models_json: "[]".into(),
        allowed_provider_ids_json: r#"["first"]"#.into(),
        max_concurrent: 32,
        max_rpm: 600,
        max_rpd: 50_000,
        revision: 5,
    };
    db.upsert_client_key(&client_key).await.unwrap();
    assert_eq!(db.client_keys().await.unwrap(), vec![client_key.clone()]);
    db.revoke_client_key("agent-fleet", 6).await.unwrap();
    let mut revoked_key = client_key.clone();
    revoked_key.enabled = false;
    revoked_key.revision = 6;
    assert_eq!(db.client_keys().await.unwrap(), vec![revoked_key.clone()]);
    let combo = StoredCombo {
        id: "agent-combo".into(),
        protocol: "openai".into(),
        strategy: "priority".into(),
        fallback: true,
        targets_json: r#"[{"provider_id":"first","model":"openai/model"}]"#.into(),
        enabled: true,
        revision: 7,
    };
    db.upsert_combo(&combo).await.unwrap();
    assert_eq!(db.combos().await.unwrap(), vec![combo.clone()]);
    db.disable_combo("agent-combo", 8).await.unwrap();
    let mut disabled_combo = combo;
    disabled_combo.enabled = false;
    disabled_combo.revision = 8;
    assert_eq!(db.combos().await.unwrap(), vec![disabled_combo.clone()]);
    db.close().await.unwrap();
    drop(db);
    let reopened = Database::connect(backend, url).await.unwrap();
    assert_eq!(
        reopened.upstream().await.unwrap().as_deref(),
        Some("https://second.example/v1/chat/completions")
    );
    assert_eq!(reopened.active_provider().await.unwrap(), Some(first));
    assert_eq!(reopened.client_keys().await.unwrap(), vec![revoked_key]);
    assert_eq!(reopened.combos().await.unwrap(), vec![disabled_combo]);
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_configuration_survives_restart() {
    let temp = TempDir::new().unwrap();
    let folder = temp.path().join("storage with spaces");
    std::fs::create_dir_all(&folder).unwrap();
    let file = Url::from_file_path(folder.join("config.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    exercise(Backend::Sqlite, &url).await;
}

#[cfg(feature = "reddb-embedded")]
#[tokio::test]
async fn embedded_reddb_configuration_survives_restart() {
    let temp = TempDir::new().unwrap();
    let folder = temp.path().join("storage with spaces");
    std::fs::create_dir_all(&folder).unwrap();
    let url = Url::from_file_path(folder.join("config.rdb")).unwrap();
    exercise(Backend::ReddbEmbedded, url.as_str()).await;
}

#[cfg(feature = "reddb-embedded")]
#[tokio::test]
async fn embedded_reddb_refuses_a_second_owner() {
    let temp = TempDir::new().unwrap();
    let url = Url::from_file_path(temp.path().join("config.rdb")).unwrap();
    let first = Database::connect(Backend::ReddbEmbedded, url.as_str())
        .await
        .unwrap();
    assert!(Database::connect(Backend::ReddbEmbedded, url.as_str())
        .await
        .is_err());
    first.close().await.unwrap();
    drop(first);
    let second = Database::connect(Backend::ReddbEmbedded, url.as_str())
        .await
        .unwrap();
    second.close().await.unwrap();
}

async fn remote(backend: Backend, variable: &str) {
    let Ok(url) = std::env::var(variable) else {
        return;
    };
    assert_eq!(
        std::env::var("RED_ROUTER_TEST_DISPOSABLE").as_deref(),
        Ok("1")
    );
    exercise(backend, &url).await;
}

#[tokio::test]
async fn remote_postgres_configuration_survives_reconnect() {
    remote(Backend::Postgres, "RED_ROUTER_TEST_POSTGRES_URL").await;
}

#[tokio::test]
async fn remote_reddb_configuration_survives_reconnect() {
    remote(Backend::ReddbRemote, "RED_ROUTER_TEST_REDDB_URL").await;
}

#[tokio::test]
async fn remote_reddb_uses_tls_and_authentication() {
    let Ok(url) = std::env::var("RED_ROUTER_TEST_REDDB_TLS_URL") else {
        return;
    };
    assert_eq!(
        std::env::var("RED_ROUTER_TEST_DISPOSABLE").as_deref(),
        Ok("1")
    );
    let parsed = Url::parse(&url).unwrap();
    let ca = parsed
        .query_pairs()
        .find(|(key, _)| key == "ca")
        .unwrap()
        .1
        .into_owned();
    let password = percent_encoding::percent_decode_str(parsed.password().unwrap())
        .decode_utf8()
        .unwrap()
        .into_owned();
    let options = reddb_client::redwire::ConnectOptions::new(
        parsed.host_str().unwrap(),
        parsed.port().unwrap(),
    )
    .with_auth(reddb_client::redwire::Auth::Basic {
        user: parsed.username().into(),
        pass: password,
    })
    .with_tls(
        reddb_client::redwire::TlsConfig::from_files(Some(std::path::Path::new(&ca)), None, None)
            .unwrap(),
    );
    reddb_client::redwire::RedWireClient::connect(options)
        .await
        .expect("synthetic authenticated TLS RedWire connection")
        .close()
        .await
        .unwrap();
    let mut wrong = parsed;
    wrong.set_password(Some("wrong-test-password")).unwrap();
    assert!(Database::connect(Backend::ReddbRemote, wrong.as_str())
        .await
        .is_err());
    exercise(Backend::ReddbRemote, &url).await;
}

#[tokio::test]
async fn unavailable_or_mismatched_database_never_falls_back() {
    assert!(Database::connect(
        Backend::Sqlite,
        "postgresql://secret:private@127.0.0.1/test"
    )
    .await
    .is_err());
    let error = match Database::connect(
        Backend::Postgres,
        "postgresql://secret:private@127.0.0.1:1/test",
    )
    .await
    {
        Ok(_) => panic!("expected connection failure"),
        Err(error) => error,
    };
    assert!(!error.contains("private"));
    for url in [
        "red://alice:private@127.0.0.1:1?token=second-secret",
        "red://127.0.0.1:1?ca=/tmp/fixture.pem",
        "red://127.0.0.1:1?unexpected=secret",
    ] {
        let error = match Database::connect(Backend::ReddbRemote, url).await {
            Ok(_) => panic!("expected invalid connection options"),
            Err(error) => error,
        };
        assert!(!error.contains("private") && !error.contains("secret"));
    }
}
