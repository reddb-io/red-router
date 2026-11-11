use red_routerd::{
    legacy_archive,
    storage::{Backend, Database},
};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use tempfile::TempDir;
use url::Url;

async fn fixture() -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
    let dir = TempDir::new().unwrap();
    let source = dir.path().join("legacy #space.sqlite");
    let destination = dir.path().join("rust.sqlite");
    let mut input = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql(r#"
        CREATE TABLE usage_history (id INTEGER PRIMARY KEY, provider TEXT, payload BLOB, exact_usd REAL, note TEXT);
        INSERT INTO usage_history VALUES (7,'openai',x'0001FF',0.00000031,NULL), (9,'other',x'',4.75,'text');
        CREATE TABLE request_cost_ledger (id INTEGER PRIMARY KEY, api_key_id TEXT, amount_usd REAL, tenant_id TEXT, usage_attributes TEXT);
        INSERT INTO request_cost_ledger VALUES (4,'key-a',0.00000031,'acme','{"team":"infra"}');
        CREATE TABLE api_key_quota_counters (api_key_id TEXT, dimension_key TEXT, bucket_index INTEGER, consumed REAL);
        INSERT INTO api_key_quota_counters VALUES ('key-a','key-quota:tpm',42,17.5);
        CREATE TABLE api_key_usage_reservations (id TEXT PRIMARY KEY, state TEXT, reserved_usd REAL);
        INSERT INTO api_key_usage_reservations VALUES ('event-a','dispatched',0.00000031);
    "#).execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    let file = Url::from_file_path(&destination).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    (dir, source, destination)
}

#[tokio::test]
async fn archives_usage_and_counters_without_rounding_or_modifying_source() {
    let (_dir, source, destination) = fixture().await;
    let before = tokio::fs::read(&source).await.unwrap();
    let report = legacy_archive::archive(&source, &destination)
        .await
        .unwrap();
    assert_eq!(
        report
            .tables
            .iter()
            .find(|table| table.source == "usage_history")
            .unwrap()
            .rows,
        Some(2)
    );
    assert_eq!(
        report
            .tables
            .iter()
            .find(|table| table.source == "api_key_quota_counters")
            .unwrap()
            .rows,
        Some(1)
    );
    assert_eq!(
        report
            .tables
            .iter()
            .find(|table| table.source == "budgets")
            .unwrap()
            .rows,
        None
    );
    assert_eq!(before, tokio::fs::read(&source).await.unwrap());
    let mut output =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&destination))
            .await
            .unwrap();
    let row = sqlx::query("SELECT __legacy_rowid,provider,hex(payload) AS payload,exact_usd,note FROM redrouter_legacy_usage_history WHERE id=7").fetch_one(&mut output).await.unwrap();
    assert_eq!(row.get::<i64, _>("__legacy_rowid"), 7);
    assert_eq!(row.get::<String, _>("payload"), "0001FF");
    assert_eq!(row.get::<f64, _>("exact_usd"), 0.00000031);
    assert_eq!(row.get::<Option<String>, _>("note"), None);
    let counters: (String, f64) = sqlx::query_as(
        "SELECT dimension_key,consumed FROM redrouter_legacy_api_key_quota_counters",
    )
    .fetch_one(&mut output)
    .await
    .unwrap();
    assert_eq!(counters, ("key-quota:tpm".to_owned(), 17.5));
    let native: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_usage_ledger")
        .fetch_one(&mut output)
        .await
        .unwrap();
    assert_eq!(
        native, 0,
        "staging must not silently affect live quota accounting"
    );
    output.close().await.unwrap();
    assert!(legacy_archive::archive(&source, &destination)
        .await
        .is_err());
    assert!(legacy_archive::archive(&source, &source).await.is_err());
}

#[tokio::test]
async fn unsupported_late_table_rolls_back_the_whole_archive() {
    let (_dir, source, destination) = fixture().await;
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE api_key_token_counters (id TEXT PRIMARY KEY) WITHOUT ROWID; INSERT INTO api_key_token_counters VALUES ('not-supported');").execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    assert!(legacy_archive::archive(&source, &destination)
        .await
        .is_err());
    let mut output =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&destination))
            .await
            .unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'redrouter_legacy_%'",
    )
    .fetch_one(&mut output)
    .await
    .unwrap();
    assert_eq!(
        count, 0,
        "the manifest and earlier tables must roll back together"
    );
    output.close().await.unwrap();
}
