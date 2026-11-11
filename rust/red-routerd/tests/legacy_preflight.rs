use red_routerd::legacy_preflight;
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::TempDir;

#[tokio::test]
async fn inspection_counts_known_tables_without_exposing_or_modifying_records() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("legacy.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql("CREATE TABLE provider_connections (id TEXT, api_key TEXT); INSERT INTO provider_connections VALUES ('private-id','secret-provider'); CREATE TABLE api_keys (id TEXT, key TEXT); INSERT INTO api_keys VALUES ('private-key','secret-client'); CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT); INSERT INTO key_value VALUES ('pricing','cohere','secret-pricing'),('settings','unrelated','secret-setting');")
        .execute(&mut db).await.unwrap();
    db.close().await.unwrap();
    let before = tokio::fs::read(&path).await.unwrap();
    let report = legacy_preflight::inspect(&path).await.unwrap();
    let encoded = serde_json::to_string(&report).unwrap();
    assert!(!report.migration_ready);
    assert_eq!(report.pricing_rows, Some(1));
    assert_eq!(
        report
            .tables
            .iter()
            .find(|item| item.table == "provider_connections")
            .unwrap()
            .rows,
        Some(1)
    );
    assert_eq!(
        report
            .tables
            .iter()
            .find(|item| item.table == "api_keys")
            .unwrap()
            .rows,
        Some(1)
    );
    assert_eq!(
        report
            .tables
            .iter()
            .find(|item| item.table == "combos")
            .unwrap()
            .rows,
        None
    );
    assert!(!encoded.contains("secret-"));
    assert!(!encoded.contains("private-"));
    assert_eq!(before, tokio::fs::read(&path).await.unwrap());
}

#[tokio::test]
async fn inspection_refuses_missing_database_without_creating_it() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("missing.sqlite");
    assert!(legacy_preflight::inspect(&path).await.is_err());
    assert!(!path.exists());
}
