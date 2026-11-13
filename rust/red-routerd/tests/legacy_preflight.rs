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
    sqlx::raw_sql("CREATE TABLE provider_connections (id TEXT, api_key TEXT); INSERT INTO provider_connections VALUES ('private-id','secret-provider'); CREATE TABLE api_keys (id TEXT, key TEXT); INSERT INTO api_keys VALUES ('private-key','secret-client'); CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT); INSERT INTO key_value VALUES ('pricing','cohere','secret-pricing'),('settings','unrelated','secret-setting'),('customModels','private-provider','secret-model'),('modelAliases','private-alias','secret-target');")
        .execute(&mut db).await.unwrap();
    db.close().await.unwrap();
    let before = tokio::fs::read(&path).await.unwrap();
    let report = legacy_preflight::inspect(&path).await.unwrap();
    let encoded = serde_json::to_string(&report).unwrap();
    assert!(!report.migration_ready);
    assert_eq!(report.pricing_rows, Some(1));
    assert_eq!(report.version, 2);
    assert_eq!(
        report
            .model_namespaces
            .iter()
            .find(|item| item.namespace == "customModels")
            .unwrap()
            .rows,
        Some(1)
    );
    assert_eq!(
        report
            .model_namespaces
            .iter()
            .find(|item| item.namespace == "modelAliases")
            .unwrap()
            .rows,
        Some(1)
    );
    assert_eq!(
        report
            .model_namespaces
            .iter()
            .find(|item| item.namespace == "providerAliases")
            .unwrap()
            .rows,
        Some(0)
    );
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
async fn inspection_distinguishes_missing_model_storage_from_empty_namespaces() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("legacy.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let db = SqliteConnection::connect_with(&options).await.unwrap();
    db.close().await.unwrap();
    let report = legacy_preflight::inspect(&path).await.unwrap();
    assert!(report
        .model_namespaces
        .iter()
        .all(|item| item.rows.is_none()));
}

#[tokio::test]
async fn inspection_refuses_missing_database_without_creating_it() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("missing.sqlite");
    assert!(legacy_preflight::inspect(&path).await.is_err());
    assert!(!path.exists());
}

#[tokio::test]
async fn pricing_import_is_atomic_idempotent_and_does_not_touch_source() {
    let directory = TempDir::new().unwrap();
    let source = directory.path().join("legacy.sqlite");
    let destination = directory.path().join("rust.sqlite");
    let options = |path: &std::path::Path| {
        SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
    };
    let mut input = SqliteConnection::connect_with(&options(&source))
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT, PRIMARY KEY(namespace,key)); INSERT INTO key_value VALUES ('pricing','a','{\"price\":1}'),('pricing','b','{\"price\":2}'),('settings','secret','do-not-copy');")
        .execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    let source_bytes = tokio::fs::read(&source).await.unwrap();
    let mut output = SqliteConnection::connect_with(&options(&destination))
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT, PRIMARY KEY(namespace,key)); INSERT INTO key_value VALUES ('pricing','b','different');")
        .execute(&mut output).await.unwrap();
    output.close().await.unwrap();

    assert!(legacy_preflight::import_pricing(&source, &destination)
        .await
        .is_err());
    let mut output = SqliteConnection::connect_with(&options(&destination))
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM key_value WHERE key = 'a'")
        .fetch_one(&mut output)
        .await
        .unwrap();
    assert_eq!(count, 0, "conflict must roll back earlier inserts");
    sqlx::query("UPDATE key_value SET value = ? WHERE namespace='pricing' AND key='b'")
        .bind(r#"{"price":2}"#)
        .execute(&mut output)
        .await
        .unwrap();
    output.close().await.unwrap();

    let imported = legacy_preflight::import_pricing(&source, &destination)
        .await
        .unwrap();
    assert_eq!((imported.inserted, imported.already_present), (1, 1));
    let repeated = legacy_preflight::import_pricing(&source, &destination)
        .await
        .unwrap();
    assert_eq!((repeated.inserted, repeated.already_present), (0, 2));
    assert_eq!(source_bytes, tokio::fs::read(&source).await.unwrap());
    let mut output = SqliteConnection::connect_with(&options(&destination))
        .await
        .unwrap();
    let settings: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM key_value WHERE namespace='settings'")
            .fetch_one(&mut output)
            .await
            .unwrap();
    assert_eq!(settings, 0);
    assert!(legacy_preflight::import_pricing(&source, &source)
        .await
        .is_err());
}
