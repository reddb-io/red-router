use red_routerd::{
    legacy_keys,
    storage::{Backend, Database},
};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::TempDir;
use url::Url;

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
        CREATE TABLE api_key_token_limits (id TEXT);
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
async fn imports_unrestricted_keys_as_hashes_and_preserves_status_tenant_and_format() {
    use sha2::{Digest, Sha256};
    let (_dir, source, dest, url) = fixture().await;
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
    sqlx::query("UPDATE api_keys SET allowed_models='[\"openai/gpt\"]' WHERE id='second'")
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
    sqlx::raw_sql("UPDATE api_keys SET allowed_models='[]'; INSERT INTO api_key_token_limits VALUES ('first');").execute(&mut input).await.unwrap();
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
