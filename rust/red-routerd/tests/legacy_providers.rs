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
    assert_eq!(auth[0].label, "My OpenRouter");
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
