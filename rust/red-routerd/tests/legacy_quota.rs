use red_routerd::{
    legacy_archive, legacy_quota, reconcile,
    storage::{Backend, Database},
};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::TempDir;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use url::Url;

async fn fixture() -> (TempDir, std::path::PathBuf) {
    let dir = TempDir::new().unwrap();
    let source = dir.path().join("legacy.sqlite");
    let destination = dir.path().join("native.sqlite");
    let mut input = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TABLE usage_history (id INTEGER PRIMARY KEY); CREATE TABLE request_cost_ledger (id INTEGER PRIMARY KEY,api_key_id TEXT,tenant_id TEXT,timestamp TEXT,tokens_input INTEGER,tokens_output INTEGER,amount_usd REAL,success INTEGER); CREATE TABLE api_key_quota_limits (api_key_id TEXT PRIMARY KEY,tpm_limit INTEGER,rpm_limit INTEGER,monthly_amount_usd REAL); INSERT INTO api_key_quota_limits VALUES ('key-a',200,5,0.00010001); CREATE TABLE api_key_daily_token_limits (api_key_id TEXT PRIMARY KEY,daily_tokens_limit INTEGER); INSERT INTO api_key_daily_token_limits VALUES ('key-a',1000); CREATE TABLE api_key_quota_counters (api_key_id TEXT,dimension_key TEXT,bucket_index INTEGER,consumed REAL,updated_at INTEGER); CREATE TABLE api_key_usage_reservations (id TEXT PRIMARY KEY,api_key_id TEXT,reserved_tokens INTEGER,reserved_usd REAL,created_at INTEGER,state TEXT,provider TEXT,model TEXT);").execute(&mut input).await.unwrap();
    let now = OffsetDateTime::now_utc();
    let now_ms = (now.unix_timestamp_nanos() / 1_000_000) as i64;
    sqlx::query("INSERT INTO request_cost_ledger VALUES (1,'key-a','red',?,100,30,0.00000031,1)")
        .bind(now.format(&Rfc3339).unwrap())
        .execute(&mut input)
        .await
        .unwrap();
    for (dimension, amount) in [("key-quota:tpm", 2.5_f64), ("key-quota:rpm", 4.0)] {
        sqlx::query("INSERT INTO api_key_quota_counters VALUES ('key-a',?,?,?,?)")
            .bind(dimension)
            .bind(now_ms / 60_000)
            .bind(amount)
            .bind(now_ms)
            .execute(&mut input)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO api_key_usage_reservations VALUES ('hold-a','key-a',20,0.0000001,?,'reserved',NULL,NULL)")
        .bind(now_ms).execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    let file = Url::from_file_path(&destination).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    legacy_archive::archive(&source, &destination)
        .await
        .unwrap();
    let mut output =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&destination))
            .await
            .unwrap();
    sqlx::raw_sql("CREATE TABLE redrouter_legacy_key_migration (key_id TEXT PRIMARY KEY,source_is_active INTEGER,source_is_banned INTEGER,source_revoked_at TEXT); INSERT INTO redrouter_legacy_key_migration VALUES ('key-a',1,0,NULL); INSERT INTO redrouter_control_client_keys VALUES ('key-a','A','hash',0,0,'[]','[]','[]','[]','[]',0,0,0,1); INSERT INTO redrouter_control_client_key_ownership VALUES ('key-a','red','legacy-migration',1); INSERT INTO redrouter_control_client_key_quotas VALUES ('key-a',0,0,0,0,0,1);").execute(&mut output).await.unwrap();
    output.close().await.unwrap();
    (dir, destination)
}

#[tokio::test]
async fn native_reconciliation_is_atomic_audited_and_only_records_usage_once() {
    let (_dir, destination) = fixture().await;
    legacy_quota::adopt(&destination, "key-a", 50, 10)
        .await
        .unwrap();
    let pending = reconcile::list_native(&destination).await.unwrap();
    assert_eq!(pending["reservations"][0]["id"], "hold-a");
    let now_ms = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
    let mut report = serde_json::json!({
        "timestamp_ms": now_ms,
        "amount_microusd": 25,
        "evidence": "provider statement request 42",
        "usage": {"prompt_tokens": 12, "completion_tokens": 8,
                  "completion_tokens_details": {"reasoning_tokens": 2}}
    });
    report["evidence"] = serde_json::json!("");
    assert!(reconcile::reconcile_native(&destination, "hold-a", &report)
        .await
        .is_err());
    report["evidence"] = serde_json::json!("provider statement request 42");
    let (first, second) = tokio::join!(
        reconcile::reconcile_native(&destination, "hold-a", &report),
        reconcile::reconcile_native(&destination, "hold-a", &report)
    );
    assert_ne!(first.is_ok(), second.is_ok());
    let mut db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&destination))
            .await
            .unwrap();
    let ledger: (i64, i64, i64, i64, String) = sqlx::query_as("SELECT tokens_input,tokens_output,tokens_reasoning,amount_microusd,pricing_snapshot FROM redrouter_usage_ledger WHERE event_id='hold-a'")
        .fetch_one(&mut db).await.unwrap();
    assert_eq!((ledger.0, ledger.1, ledger.2, ledger.3), (12, 8, 2, 25));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&ledger.4).unwrap()["source"],
        "operator-reconciliation"
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM redrouter_usage_reservations WHERE event_id='hold-a'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(count, 0);
    let counter: i64 = sqlx::query_scalar("SELECT consumed_tokens FROM redrouter_usage_counters WHERE key_id='key-a' AND minute_bucket=?")
        .bind(now_ms / 60_000).fetch_one(&mut db).await.unwrap();
    assert!(counter >= 22);
}

#[tokio::test]
async fn adopts_daily_monthly_counters_and_pending_holds_once() {
    let (_dir, destination) = fixture().await;
    let report = legacy_quota::adopt(&destination, "key-a", 50, 10)
        .await
        .unwrap();
    assert_eq!(
        (
            report.daily_tokens,
            report.monthly_microusd,
            report.reservations,
            report.counters
        ),
        (130, 1, 1, 2)
    );
    let mut db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&destination))
            .await
            .unwrap();
    let baseline: (String, i64, i64) = sqlx::query_as("SELECT tenant_id,daily_tokens,monthly_microusd FROM redrouter_legacy_quota_baselines WHERE key_id='key-a'").fetch_one(&mut db).await.unwrap();
    assert_eq!(baseline, ("red".to_owned(), 130, 1));
    let hold: (String, String, i64, i64) = sqlx::query_as("SELECT state,provider,reserved_tokens,reserved_microusd FROM redrouter_usage_reservations WHERE event_id='hold-a'").fetch_one(&mut db).await.unwrap();
    assert_eq!(
        hold,
        ("dispatched".to_owned(), "legacy-unknown".to_owned(), 20, 1)
    );
    let token_counter: i64 = sqlx::query_scalar(
        "SELECT consumed_tokens FROM redrouter_usage_counters WHERE key_id='key-a'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(token_counter, 3);
    let limits: (i64,i64,i64,i64,i64) = sqlx::query_as("SELECT max_tokens_per_minute,max_tokens_per_day,max_monthly_microusd,reservation_tokens,reservation_microusd FROM redrouter_control_client_key_quotas WHERE key_id='key-a'").fetch_one(&mut db).await.unwrap();
    assert_eq!(limits, (200, 1000, 100, 50, 10));
    let rpm: i64 =
        sqlx::query_scalar("SELECT max_rpm FROM redrouter_control_client_keys WHERE id='key-a'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(rpm, 5);
    db.close().await.unwrap();
    assert!(legacy_quota::adopt(&destination, "key-a", 50, 10)
        .await
        .is_err());
}

#[tokio::test]
async fn reservation_collision_rolls_back_the_entire_adoption() {
    let (_dir, destination) = fixture().await;
    let mut db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&destination))
            .await
            .unwrap();
    sqlx::raw_sql("INSERT INTO redrouter_usage_reservations VALUES ('hold-a','different-key','red','openai','gpt',1,1,1700000000000,'dispatched');").execute(&mut db).await.unwrap();
    db.close().await.unwrap();
    assert!(legacy_quota::adopt(&destination, "key-a", 50, 10)
        .await
        .is_err());
    let mut db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&destination))
            .await
            .unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM redrouter_legacy_quota_baselines WHERE key_id='key-a'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(count, 0);
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_usage_counters WHERE key_id='key-a'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let limits: (i64, i64, i64, i64) = sqlx::query_as("SELECT max_tokens_per_minute,max_tokens_per_day,max_monthly_microusd,reservation_tokens FROM redrouter_control_client_key_quotas WHERE key_id='key-a'").fetch_one(&mut db).await.unwrap();
    assert_eq!(
        limits,
        (0, 0, 0, 0),
        "a reservation collision must roll back the adopted limits"
    );
}
