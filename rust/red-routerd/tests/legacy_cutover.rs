use red_routerd::legacy_cutover;
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::tempdir;

const STORAGE_KEY: &str = "0123456789abcdef0123456789abcdef";

#[tokio::test]
async fn orchestrated_migration_restores_destination_when_a_later_slice_fails() {
    let directory = tempdir().unwrap();
    let source = directory.path().join("legacy.sqlite");
    let destination = directory.path().join("rust.sqlite");
    let rollback = directory.path().join("rust.before-cutover.sqlite");

    let mut legacy = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TABLE key_value(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace,key)); INSERT INTO key_value VALUES('pricing','snapshot','new-price');")
        .execute(&mut legacy)
        .await
        .unwrap();
    legacy.close().await.unwrap();

    let mut rust = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&destination)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TABLE key_value(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace,key)); INSERT INTO key_value VALUES('existing','sentinel','unchanged');")
        .execute(&mut rust)
        .await
        .unwrap();
    rust.close().await.unwrap();

    let error = match legacy_cutover::migrate(&source, &destination, &rollback, STORAGE_KEY).await {
        Ok(_) => panic!("incomplete legacy schema must fail"),
        Err(error) => error,
    };
    assert!(error.contains("migration failed during client keys"));
    assert!(error.contains("destination restored"));
    assert!(rollback.exists());

    let mut restored = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&destination)
            .read_only(true),
    )
    .await
    .unwrap();
    let sentinel: String = sqlx::query_scalar(
        "SELECT value FROM key_value WHERE namespace='existing' AND key='sentinel'",
    )
    .fetch_one(&mut restored)
    .await
    .unwrap();
    let imported: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM key_value WHERE namespace='pricing'")
            .fetch_one(&mut restored)
            .await
            .unwrap();
    assert_eq!(sentinel, "unchanged");
    assert_eq!(imported, 0);
}
