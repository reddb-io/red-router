use futures_util::{stream, StreamExt};
use red_routerd::shared_usage::{
    cancel_undispatched, mark_dispatched, reserve_usage, UsageReservation,
};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::{
    io::{BufRead, Read, Write},
    process::{Command, Stdio},
    time::Duration,
};

#[tokio::test]
async fn rust_and_typescript_reserve_one_shared_token_and_spend_budget() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shared.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .busy_timeout(Duration::from_secs(10));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../src/lib/db/migrations/182_request_cost_ledger_and_key_quota.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../src/lib/db/migrations/191_api_key_daily_token_quota.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../src/lib/db/migrations/226_shared_usage_reservations.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../src/lib/db/migrations/219_cost_ledger_recovery.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TABLE api_keys (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL); INSERT INTO api_keys VALUES ('node-key','red'); ALTER TABLE request_cost_ledger ADD COLUMN tenant_id TEXT; ALTER TABLE request_cost_ledger ADD COLUMN pricing_known INTEGER NOT NULL DEFAULT 1;").execute(&pool).await.unwrap();
    assert!(reserve_usage(
        &pool,
        &UsageReservation {
            id: "rust-handoff",
            key_id: "node-key",
            tokens: 150,
            usd: 0.001,
            now_ms: 1_700_000_000_000
        }
    )
    .await
    .unwrap());
    assert!(mark_dispatched(&pool, "rust-handoff", "node-key")
        .await
        .unwrap());
    sqlx::query("INSERT INTO api_key_quota_limits(api_key_id,tpm_limit,monthly_amount_usd) VALUES ('key',80,1.0)").execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO api_key_daily_token_limits(api_key_id,daily_tokens_limit) VALUES ('key',80)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/shared-usage-node.mjs");
    let mut node = Command::new("node")
        .arg("--experimental-strip-types")
        .arg(fixture)
        .env("RED_ROUTER_TEST_SQLITE", &path)
        .env("NODE_NO_WARNINGS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = std::io::BufReader::new(node.stdout.take().unwrap());
    let mut ready = String::new();
    stdout.read_line(&mut ready).unwrap();
    assert_eq!(ready.trim(), "ready");
    node.stdin.take().unwrap().write_all(b"go\n").unwrap();
    let results: Vec<bool> = stream::iter(0..16)
        .map(|i| {
            let pool = pool.clone();
            async move {
                let id = format!("rust-{i}");
                reserve_usage(
                    &pool,
                    &UsageReservation {
                        id: &id,
                        key_id: "key",
                        tokens: 10,
                        usd: 0.01,
                        now_ms: 1_700_000_000_000,
                    },
                )
                .await
                .unwrap()
            }
        })
        .buffer_unordered(16)
        .collect()
        .await;
    assert!(node.wait().unwrap().success());
    let mut output = String::new();
    stdout.read_to_string(&mut output).unwrap();
    let node_result = serde_json::from_str::<serde_json::Value>(&output).unwrap();
    assert_eq!(node_result["settled"], true);
    assert_eq!(node_result["duplicate"], false);
    assert_eq!(node_result["collision"], true);
    assert_eq!(node_result["overrunReservation"], true);
    assert_eq!(node_result["dispatched"], true);
    assert_eq!(node_result["cancelled"], false);
    assert_eq!(node_result["overrun"], true);
    let quarantined: i64 = sqlx::query_scalar(
        "SELECT reserved_tokens FROM api_key_usage_reservations WHERE id = 'node-overrun'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(quarantined, 9_007_199_254_740_991);
    let node_count = node_result["allowed"].as_u64().unwrap() as usize;
    assert_eq!(results.iter().filter(|v| **v).count() + node_count, 8);
    let (count, total): (i64, i64) = sqlx::query_as("SELECT COUNT(*),SUM(reserved_tokens) FROM api_key_usage_reservations WHERE api_key_id = 'key'").fetch_one(&pool).await.unwrap();
    assert_eq!((count, total), (8, 80));
    let usage = red_routerd::accounting::ChatUsage::from_response(
        &serde_json::json!({"usage":{"prompt_tokens":100,"completion_tokens":50}}),
    )
    .unwrap();
    let prices = red_routerd::accounting::TokenPrices::from_record(
        &serde_json::json!({"input":2,"output":4}),
    )
    .unwrap();
    assert_eq!(
        red_routerd::accounting::record_reserved_usage(
            &pool,
            &red_routerd::accounting::CompletedUsage {
                event_id: "rust-handoff",
                key_id: "node-key",
                provider: "openai",
                model: "gpt",
                usage: &usage,
                prices: &prices,
                timestamp_ms: 1_700_000_000_000
            }
        )
        .await,
        Ok(false)
    );
    let id: String = sqlx::query_scalar("SELECT id FROM api_key_usage_reservations LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(mark_dispatched(&pool, &id, "key").await.unwrap());
    assert!(!cancel_undispatched(&pool, &id, "key").await.unwrap());
    assert!(!reserve_usage(
        &pool,
        &UsageReservation {
            id: "extra",
            key_id: "key",
            tokens: 1,
            usd: 0.0,
            now_ms: 1_700_000_000_000
        }
    )
    .await
    .unwrap());
    let other: String = sqlx::query_scalar(
        "SELECT id FROM api_key_usage_reservations WHERE state = 'reserved' LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(cancel_undispatched(&pool, &other, "key").await.unwrap());
    assert!(reserve_usage(
        &pool,
        &UsageReservation {
            id: "extra",
            key_id: "key",
            tokens: 10,
            usd: 0.01,
            now_ms: 1_700_000_000_000
        }
    )
    .await
    .unwrap());
}

#[tokio::test]
async fn daily_and_monthly_limits_include_ledger_and_uncertain_reservations() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../src/lib/db/migrations/182_request_cost_ledger_and_key_quota.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../src/lib/db/migrations/191_api_key_daily_token_quota.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../src/lib/db/migrations/226_shared_usage_reservations.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO api_key_quota_limits(api_key_id,monthly_amount_usd) VALUES ('key',0.5)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO api_key_daily_token_limits VALUES ('key',50,'now')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO request_cost_ledger(api_key_id,provider,model,tokens_input,tokens_output,amount_usd,timestamp) VALUES ('key','openai','gpt',30,10,0.3,'2023-11-14T12:00:00.000Z')").execute(&pool).await.unwrap();
    let req = |id: &'static str, tokens, usd| UsageReservation {
        id,
        key_id: "key",
        tokens,
        usd,
        now_ms: 1_700_000_000_000,
    };
    assert!(!reserve_usage(&pool, &req("too-many-tokens", 11, 0.1))
        .await
        .unwrap());
    assert!(!reserve_usage(&pool, &req("too-much-usd", 1, 0.21))
        .await
        .unwrap());
    assert!(reserve_usage(&pool, &req("valid", 10, 0.1)).await.unwrap());
    assert!(mark_dispatched(&pool, "valid", "key").await.unwrap());
    let next_month = UsageReservation {
        id: "next-month",
        key_id: "key",
        tokens: 41,
        usd: 0.01,
        now_ms: 1_702_592_000_000,
    };
    assert!(
        !reserve_usage(&pool, &next_month).await.unwrap(),
        "unreconciled reservations survive calendar rollover"
    );
    assert!(!cancel_undispatched(&pool, "valid", "key").await.unwrap());
}
