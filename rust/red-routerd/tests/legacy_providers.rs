use aes_gcm::{
    aead::{consts::U16, Aead, KeyInit, Payload},
    aes::Aes256,
    AesGcm, Nonce,
};
use red_routerd::{
    legacy_providers,
    storage::{Backend, Database},
};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::TempDir;
use url::Url;

type Cipher = AesGcm<Aes256, U16>;
const STORAGE_KEY: &str = "a-test-storage-password-1234";
const SECRET: &str = "provider-secret-do-not-expose";

fn legacy_ciphertext() -> String {
    let mut key = [0u8; 32];
    let params = scrypt::Params::new(14, 8, 1, 32).unwrap();
    scrypt::scrypt(
        STORAGE_KEY.as_bytes(),
        b"omniroute-field-encryption-v1",
        &params,
        &mut key,
    )
    .unwrap();
    let iv = [7u8; 16];
    let cipher = Cipher::new_from_slice(&key).unwrap();
    let encrypted = cipher
        .encrypt(Nonce::<U16>::from_slice(&iv), SECRET.as_bytes())
        .unwrap();
    let (body, tag) = encrypted.split_at(encrypted.len() - 16);
    format!(
        "enc:v1:{}:{}:{}",
        hex::encode(iv),
        hex::encode(body),
        hex::encode(tag)
    )
}

fn decrypt_rust_ciphertext(value: &str, id: &str) -> String {
    let parts: Vec<_> = value.split(':').collect();
    assert_eq!(&parts[..2], &["rr", "v1"]);
    let salt = hex::decode(parts[2]).unwrap();
    let nonce = hex::decode(parts[3]).unwrap();
    let ciphertext = hex::decode(parts[4]).unwrap();
    let mut key = [0u8; 32];
    scrypt::scrypt(
        STORAGE_KEY.as_bytes(),
        &salt,
        &scrypt::Params::new(14, 8, 1, 32).unwrap(),
        &mut key,
    )
    .unwrap();
    let cipher = Cipher::new_from_slice(&key).unwrap();
    String::from_utf8(
        cipher
            .decrypt(
                Nonce::<U16>::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: id.as_bytes(),
                },
            )
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn stages_encrypted_provider_credential_without_activating_or_exposing_it() {
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
    sqlx::raw_sql("CREATE TABLE provider_connections (id TEXT PRIMARY KEY,provider TEXT,auth_type TEXT,name TEXT,display_name TEXT,email TEXT,is_active INTEGER,api_key TEXT,tenant_id TEXT,access_token TEXT,refresh_token TEXT,id_token TEXT,expires_at TEXT,token_expires_at TEXT,scope TEXT,project_id TEXT,provider_specific_data TEXT,rate_limited_until TEXT,per_key_proxy_enabled INTEGER,proxy_enabled INTEGER,max_concurrent INTEGER,quota_window_thresholds_json TEXT,rate_limit_overrides_json TEXT,default_model TEXT,\"group\" TEXT,test_status TEXT);")
        .execute(&mut input).await.unwrap();
    sqlx::query("INSERT INTO provider_connections (id,provider,auth_type,name,is_active,api_key,tenant_id) VALUES ('provider-1','openrouter','apikey','My OpenRouter',1,?,'red')")
        .bind(legacy_ciphertext()).execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    let file = Url::from_file_path(&dest).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::query("UPDATE provider_connections SET provider_specific_data='{\"baseUrl\":\"https://other.example\"}'").execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    assert!(
        legacy_providers::import(&source, &dest, "provider-1", STORAGE_KEY)
            .await
            .is_err()
    );
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    let legacy_label = "é".repeat(200);
    sqlx::query("UPDATE provider_connections SET display_name=?")
        .bind(&legacy_label)
        .execute(&mut input)
        .await
        .unwrap();
    sqlx::query("UPDATE provider_connections SET provider_specific_data=NULL")
        .execute(&mut input)
        .await
        .unwrap();
    input.close().await.unwrap();
    let before = tokio::fs::read(&source).await.unwrap();
    assert!(
        legacy_providers::import(&source, &dest, "provider-1", "incorrect-password-1234")
            .await
            .is_err()
    );
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert!(db.providers().await.unwrap().is_empty());
    db.close().await.unwrap();
    let report = legacy_providers::import(&source, &dest, "provider-1", STORAGE_KEY)
        .await
        .unwrap();
    assert_eq!(
        (report.imported, report.enabled, report.source_enabled),
        (1, false, true)
    );
    assert_eq!(before, tokio::fs::read(&source).await.unwrap());
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let providers = db.providers().await.unwrap();
    assert_eq!(providers.len(), 1);
    assert!(!providers[0].enabled);
    assert_eq!(providers[0].tenant_id, "red");
    assert_eq!(
        providers[0].upstream_url,
        "https://openrouter.ai/api/v1/chat/completions"
    );
    assert_ne!(providers[0].credential_ciphertext, SECRET);
    assert_eq!(
        decrypt_rust_ciphertext(&providers[0].credential_ciphertext, "provider-1"),
        SECRET
    );
    assert!(!format!("{providers:?}").contains(SECRET));
    let auth = db.provider_auth().await.unwrap();
    assert_eq!(auth[0].label, legacy_label);
    db.close().await.unwrap();
    assert!(
        legacy_providers::import(&source, &dest, "provider-1", STORAGE_KEY)
            .await
            .is_err()
    );
    assert!(
        legacy_providers::import(&source, &source, "provider-1", STORAGE_KEY)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn stages_complete_oauth_records_as_encrypted_inert_envelopes() {
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
    sqlx::raw_sql("CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, auth_type TEXT, access_token TEXT, refresh_token TEXT, provider_specific_data TEXT, priority INTEGER, tenant_id TEXT);")
        .execute(&mut input).await.unwrap();
    sqlx::query(
        "INSERT INTO provider_connections VALUES ('session-1','codex','oauth',?,?,?,17,'acme')",
    )
    .bind("oauth-access-private-token")
    .bind("oauth-refresh-private-token")
    .bind(r#"{"accountId":"acc-1","extra":"value"}"#)
    .execute(&mut input)
    .await
    .unwrap();
    input.close().await.unwrap();
    let file = Url::from_file_path(&dest).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    let before = tokio::fs::read(&source).await.unwrap();
    let report = legacy_providers::stage(&source, &dest, STORAGE_KEY)
        .await
        .unwrap();
    assert_eq!(report.staged, 1);
    assert_eq!(before, tokio::fs::read(&source).await.unwrap());
    let mut output = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&dest))
        .await
        .unwrap();
    let encrypted: String = sqlx::query_scalar("SELECT encrypted_record FROM redrouter_legacy_provider_records WHERE provider_id='session-1'").fetch_one(&mut output).await.unwrap();
    assert!(!encrypted.contains("oauth-refresh-private-token"));
    let raw = decrypt_rust_ciphertext(&encrypted, "legacy-provider-stage:session-1");
    let record: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(record["refresh_token"], "oauth-refresh-private-token");
    assert_eq!(record["access_token"], "oauth-access-private-token");
    assert_eq!(
        record["provider_specific_data"],
        r#"{"accountId":"acc-1","extra":"value"}"#
    );
    assert_eq!(record["tenant_id"], "acme");
    assert_eq!(record["priority"], 17);
    let active: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_providers")
        .fetch_one(&mut output)
        .await
        .unwrap();
    assert_eq!(
        active, 0,
        "staging must not create or refresh an OAuth session"
    );
    output.close().await.unwrap();
    let destination_bytes = tokio::fs::read(&dest).await.unwrap();
    assert!(!destination_bytes
        .windows(b"oauth-refresh-private-token".len())
        .any(|part| part == b"oauth-refresh-private-token"));
    assert!(legacy_providers::stage(&source, &dest, STORAGE_KEY)
        .await
        .is_err());
}

#[tokio::test]
async fn adopts_codex_oauth_without_refresh_and_rejects_workspace_mismatch() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let jwt = |payload: serde_json::Value| {
        format!(
            "{}.{}.signature",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
        )
    };
    let id_token = jwt(
        serde_json::json!({"sub":"user-1", "email":"owner@example.com", "https://api.openai.com/auth":{"chatgpt_account_id":"workspace-1"}, "exp":2000000000}),
    );
    let access = jwt(serde_json::json!({"exp":2000000000}));
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
    sqlx::raw_sql("CREATE TABLE provider_connections (id TEXT PRIMARY KEY,provider TEXT,auth_type TEXT,is_active INTEGER,tenant_id TEXT,name TEXT,display_name TEXT,email TEXT,access_token TEXT,refresh_token TEXT,id_token TEXT,provider_specific_data TEXT,project_id TEXT,token_type TEXT,scope TEXT,per_key_proxy_enabled INTEGER,proxy_enabled INTEGER,max_concurrent INTEGER,priority INTEGER,global_priority INTEGER,backoff_level INTEGER,rate_limit_protection INTEGER,quota_window_thresholds_json TEXT,rate_limit_overrides_json TEXT,rate_limited_until TEXT,default_model TEXT,\"group\" TEXT,api_key TEXT,test_status TEXT,error_code TEXT,last_error TEXT,last_error_type TEXT,last_error_source TEXT,expires_at TEXT,token_expires_at TEXT);")
        .execute(&mut input).await.unwrap();
    let legacy_oauth_label = "🦀".repeat(100);
    for (id, workspace) in [
        ("codex-good", "workspace-1"),
        ("codex-wrong", "workspace-other"),
    ] {
        sqlx::query("INSERT INTO provider_connections (id,provider,auth_type,is_active,tenant_id,name,access_token,refresh_token,id_token,provider_specific_data) VALUES (?,'codex','oauth',1,'red','My Codex',?,?,?,?)")
            .bind(id).bind(&access).bind("private-refresh-token").bind(&id_token).bind(serde_json::json!({"workspaceId":workspace}).to_string()).execute(&mut input).await.unwrap();
    }
    sqlx::query("UPDATE provider_connections SET name=? WHERE id='codex-good'")
        .bind(&legacy_oauth_label)
        .execute(&mut input)
        .await
        .unwrap();
    sqlx::query("INSERT INTO provider_connections (id,provider,auth_type,is_active,tenant_id,name,access_token,refresh_token,id_token,provider_specific_data) VALUES ('codex-extra','codex','oauth',1,'red','My Codex',?,?,?,?)")
        .bind(&access).bind("private-refresh-token").bind(&id_token).bind(r#"{"workspaceId":"workspace-1","accountProxies":{"x":"proxy"}}"#).execute(&mut input).await.unwrap();
    sqlx::query("INSERT INTO provider_connections (id,provider,auth_type,is_active,tenant_id,name,access_token,refresh_token,id_token,provider_specific_data,proxy_enabled) VALUES ('codex-proxy','codex','oauth',1,'red','My Codex',?,?,?,?,1)")
        .bind(&access).bind("private-refresh-token").bind(&id_token).bind(r#"{"workspaceId":"workspace-1"}"#).execute(&mut input).await.unwrap();
    for (id, project) in [("agy-good", "project-1"), ("agy-wrong", "project-other")] {
        sqlx::query("INSERT INTO provider_connections (id,provider,auth_type,is_active,tenant_id,name,access_token,refresh_token,project_id,token_type,provider_specific_data,expires_at) VALUES (?,'agy','oauth',1,'red','My Antigravity','agy-private-access','agy-private-refresh','project-1','Bearer',?,'2033-05-18T03:33:20Z')")
            .bind(id).bind(serde_json::json!({"projectId":project,"clientProfile":"cli"}).to_string()).execute(&mut input).await.unwrap();
    }
    sqlx::query("INSERT INTO provider_connections (id,provider,auth_type,is_active,tenant_id,name,email,access_token,refresh_token,provider_specific_data,expires_at) VALUES ('claude-good','claude','oauth',1,'red','My Claude','claude@example.com','claude-private-access','claude-private-refresh',?,'2033-05-18T03:33:20Z')")
        .bind(serde_json::json!({
            "accountUUID":"123e4567-e89b-42d3-a456-426614174000",
            "cliUserID":"abababababababababababababababababababababababababababababababab",
            "bootstrapEmail":"claude@example.com",
            "scopes":["user:inference","user:sessions:claude_code"],
            "subscriptionType":"pro",
            "rateLimitTier":"tier-2"
        }).to_string()).execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    let file = Url::from_file_path(&dest).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    assert_eq!(
        legacy_providers::stage(&source, &dest, STORAGE_KEY)
            .await
            .unwrap()
            .staged,
        7
    );
    assert!(
        legacy_providers::adopt_codex(&dest, "codex-wrong", STORAGE_KEY, STORAGE_KEY)
            .await
            .is_err()
    );
    assert!(
        legacy_providers::adopt_codex(&dest, "codex-extra", STORAGE_KEY, STORAGE_KEY)
            .await
            .is_err()
    );
    assert!(
        legacy_providers::adopt_codex(&dest, "codex-proxy", STORAGE_KEY, STORAGE_KEY)
            .await
            .is_err()
    );
    assert!(
        legacy_providers::adopt_antigravity(&dest, "agy-wrong", STORAGE_KEY, STORAGE_KEY)
            .await
            .is_err()
    );
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert!(db.providers().await.unwrap().is_empty());
    db.close().await.unwrap();
    let result = legacy_providers::adopt_codex(&dest, "codex-good", STORAGE_KEY, STORAGE_KEY)
        .await
        .unwrap();
    assert_eq!(
        (result.imported, result.enabled, result.source_enabled),
        (1, false, true)
    );
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let providers = db.providers().await.unwrap();
    assert_eq!(providers.len(), 1);
    assert!(!providers[0].enabled);
    assert_eq!(providers[0].provider, "codex");
    assert_eq!(
        db.provider_auth().await.unwrap()[0].label,
        legacy_oauth_label
    );
    assert_eq!(
        decrypt_rust_ciphertext(&providers[0].credential_ciphertext, "codex-good"),
        access
    );
    let oauth = db.provider_oauth().await.unwrap();
    assert_eq!(
        decrypt_rust_ciphertext(
            &oauth[0].refresh_token_ciphertext,
            "codex-good:oauth-refresh"
        ),
        "private-refresh-token"
    );
    let sessions = db.provider_sessions().await.unwrap();
    let metadata =
        decrypt_rust_ciphertext(&sessions[0].session_ciphertext, "codex-good:oauth-session");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&metadata).unwrap()["id_token"],
        id_token
    );
    db.close().await.unwrap();
    assert!(
        legacy_providers::adopt_codex(&dest, "codex-good", STORAGE_KEY, STORAGE_KEY)
            .await
            .is_err()
    );
    let result = legacy_providers::adopt_antigravity(&dest, "agy-good", STORAGE_KEY, STORAGE_KEY)
        .await
        .unwrap();
    assert_eq!(
        (result.imported, result.enabled, result.source_enabled),
        (1, false, true)
    );
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let providers = db.providers().await.unwrap();
    let provider = providers
        .iter()
        .find(|provider| provider.id == "agy-good")
        .unwrap();
    assert!(!provider.enabled);
    assert_eq!(
        decrypt_rust_ciphertext(&provider.credential_ciphertext, "agy-good"),
        "agy-private-access"
    );
    let sessions = db.provider_sessions().await.unwrap();
    let session = sessions
        .iter()
        .find(|session| session.provider_id == "agy-good")
        .unwrap();
    let metadata = decrypt_rust_ciphertext(&session.session_ciphertext, "agy-good:oauth-session");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&metadata).unwrap()["projectId"],
        "project-1"
    );
    db.close().await.unwrap();
    let result = legacy_providers::adopt_claude(&dest, "claude-good", STORAGE_KEY, STORAGE_KEY)
        .await
        .unwrap();
    assert_eq!((result.imported, result.enabled), (1, false));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let provider = db
        .providers()
        .await
        .unwrap()
        .into_iter()
        .find(|provider| provider.id == "claude-good")
        .unwrap();
    assert_eq!(provider.provider, "claude");
    assert_eq!(
        provider.upstream_url,
        "https://api.anthropic.com/v1/messages"
    );
    let session = db
        .provider_sessions()
        .await
        .unwrap()
        .into_iter()
        .find(|session| session.provider_id == "claude-good")
        .unwrap();
    let metadata =
        decrypt_rust_ciphertext(&session.session_ciphertext, "claude-good:oauth-session");
    let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(
        metadata["accountUUID"],
        "123e4567-e89b-42d3-a456-426614174000"
    );
    assert_eq!(metadata["cliUserID"].as_str().unwrap().len(), 64);
    db.close().await.unwrap();
}
