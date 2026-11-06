use axum::{routing::post, Router};
use futures_util::{stream, StreamExt};
use red_routerd::{product::ProductConnection, router, ProxyState};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tempfile::TempDir;

const ENCRYPTED: &str = "enc:v1:07070707070707070707070707070707:c08df6423606efea3e7c0312a4ec91a5e0a8d368:d4c8fcd1abdb884abc46108ca32ae870";

async fn fixture() -> (TempDir, SqliteConnection) {
    let dir = TempDir::new().unwrap();
    let options = SqliteConnectOptions::new()
        .filename(dir.path().join("storage.sqlite"))
        .create_if_missing(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, auth_type TEXT, is_active INTEGER, api_key TEXT, updated_at TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'red')")
        .execute(&mut db).await.unwrap();
    sqlx::query(
        "INSERT INTO provider_connections (id, provider, auth_type, is_active, api_key, updated_at) VALUES ('test', 'openrouter', 'apikey', 1, ?, 'a')",
    )
    .bind(ENCRYPTED)
    .execute(&mut db)
    .await
    .unwrap();
    for statement in [
        "CREATE TABLE api_keys (id TEXT PRIMARY KEY, key TEXT NOT NULL, key_hash TEXT, is_active INTEGER DEFAULT 1, is_banned INTEGER DEFAULT 0, revoked_at TEXT, expires_at TEXT, max_requests_per_day INTEGER, max_requests_per_minute INTEGER, throttle_delay_ms INTEGER, max_sessions INTEGER DEFAULT 0, usage_limit_enabled INTEGER DEFAULT 0, disable_non_public_models INTEGER DEFAULT 0, auto_resolve INTEGER DEFAULT 0, access_schedule TEXT, proxy_id TEXT, tenant_id TEXT DEFAULT 'red', ip_allowlist TEXT, scopes TEXT, rate_limits TEXT, allowed_quotas TEXT DEFAULT '[]', allowed_connections TEXT, allowed_models TEXT DEFAULT '[]', blocked_models TEXT, allowed_endpoints TEXT, model_access_mode TEXT DEFAULT 'all')",
        "CREATE TABLE domain_budgets (api_key_id TEXT)",
        "CREATE TABLE api_key_token_limits (api_key_id TEXT, enabled INTEGER)",
        "CREATE TABLE api_key_quota_limits (api_key_id TEXT, tpm_limit INTEGER, rpm_limit INTEGER, monthly_amount_usd REAL)",
        "CREATE TABLE api_key_quota_counters (api_key_id TEXT, dimension_key TEXT, bucket_index INTEGER, consumed REAL, updated_at INTEGER, PRIMARY KEY(api_key_id,dimension_key,bucket_index))",
        "CREATE TABLE api_key_daily_token_limits (api_key_id TEXT)",
        "CREATE TABLE key_group_members (key_id TEXT)",
        "CREATE TABLE budget_assignments (budget_id TEXT)",
        "CREATE TABLE model_combo_mappings (enabled INTEGER)",
        "CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT)",
        "CREATE TABLE combos (name TEXT)",
    ] { sqlx::query(statement).execute(&mut db).await.unwrap(); }
    (dir, db)
}

#[tokio::test]
async fn product_credential_decryption_and_revocation() {
    let (dir, mut db) = fixture().await;
    let path = dir.path().join("storage.sqlite");
    let missing = dir.path().join("missing.sqlite");
    assert!(ProductConnection::open(&missing, "test", None)
        .await
        .is_err());
    assert!(!missing.exists());
    assert!(ProductConnection::open(&path, "test", None).await.is_err());
    assert!(ProductConnection::open(&path, "test", Some("wrong"))
        .await
        .is_err());
    assert!(
        ProductConnection::open(&path, "missing", Some("fixture-password"))
            .await
            .is_err()
    );
    let (connection, key) = ProductConnection::open(&path, "test", Some("fixture-password"))
        .await
        .unwrap();
    assert_eq!(key.as_str(), "fixture-provider-key");
    assert!(connection.unchanged().await);
    sqlx::query("UPDATE provider_connections SET updated_at = 'b' WHERE id = 'test'")
        .execute(&mut db)
        .await
        .unwrap();
    assert!(!connection.unchanged().await);
    let (connection, _) = ProductConnection::open(&path, "test", Some("fixture-password"))
        .await
        .unwrap();
    sqlx::query("UPDATE provider_connections SET is_active = 0 WHERE id = 'test'")
        .execute(&mut db)
        .await
        .unwrap();
    assert!(!connection.unchanged().await);
    assert!(
        ProductConnection::open(&path, "test", Some("fixture-password"))
            .await
            .is_err()
    );
    sqlx::query(
        "UPDATE provider_connections SET provider = 'openai', is_active = 1 WHERE id = 'test'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    let (openai, _) = ProductConnection::open(&path, "test", Some("fixture-password"))
        .await
        .unwrap();
    assert_eq!(
        openai.upstream_url(),
        "https://api.openai.com/v1/chat/completions"
    );
    assert!(openai.unchanged().await);
}

#[tokio::test]
async fn proxy_stops_using_a_changed_product_connection() {
    let (dir, mut db) = fixture().await;
    sqlx::query(
        "UPDATE provider_connections SET api_key = 'fixture-provider-key' WHERE id = 'test'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    let (connection, key) =
        ProductConnection::open(&dir.path().join("storage.sqlite"), "test", None)
            .await
            .unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_address = upstream_listener.local_addr().unwrap();
    let provider = tokio::spawn(async move {
        axum::serve(
            upstream_listener,
            Router::new().route(
                "/v1/chat/completions",
                post(move |headers: axum::http::HeaderMap| {
                    let count = count.clone();
                    async move {
                        assert_eq!(
                            headers.get("authorization").unwrap(),
                            "Bearer fixture-provider-key"
                        );
                        count.fetch_add(1, Ordering::SeqCst);
                        "ok"
                    }
                }),
            ),
        )
        .await
        .unwrap();
    });
    let state = ProxyState::new(
        &format!("http://{upstream_address}/v1/chat/completions"),
        "client-key-123456789",
        &key,
        false,
    )
    .await
    .unwrap()
    .with_product_connection(connection);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = || {
        client
            .post(format!("http://{address}/v1/chat/completions"))
            .bearer_auth("client-key-123456789")
            .header("content-type", "application/json")
            .body(r#"{"model":"openrouter/openai/gpt","messages":[]}"#)
    };
    assert_eq!(send().send().await.unwrap().status(), 200);
    sqlx::query("UPDATE provider_connections SET api_key = 'changed' WHERE id = 'test'")
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(send().send().await.unwrap().status(), 503);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    server.abort();
    provider.abort();
}

#[tokio::test]
async fn dashboard_keys_enforce_supported_policy_and_refuse_unimplemented_quotas() {
    let (dir, mut db) = fixture().await;
    sqlx::query(
        "UPDATE provider_connections SET api_key = 'fixture-provider-key' WHERE id = 'test'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO api_keys (id, key, model_access_mode, allowed_models, blocked_models, allowed_endpoints, allowed_connections) VALUES ('client', 'dashboard-client-key-12345', 'restricted', '[\"openrouter/*\"]', '[]', '[\"chat\"]', '[\"test\"]')")
        .execute(&mut db).await.unwrap();
    let hash = hex::encode(Sha256::digest(b"dashboard-hashed-key-12345"));
    sqlx::query("INSERT INTO api_keys (id, key, key_hash) VALUES ('hashed', 'hidden', ?)")
        .bind(hash)
        .execute(&mut db)
        .await
        .unwrap();
    let (connection, key) =
        ProductConnection::open(&dir.path().join("storage.sqlite"), "test", None)
            .await
            .unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_address = upstream.local_addr().unwrap();
    let provider = tokio::spawn(async move {
        axum::serve(
            upstream,
            Router::new().route(
                "/v1/chat/completions",
                post(move |axum::Json(body): axum::Json<serde_json::Value>| {
                    let count = count.clone();
                    async move {
                        assert_eq!(body["model"], "openai/gpt");
                        count.fetch_add(1, Ordering::SeqCst);
                        "ok"
                    }
                }),
            ),
        )
        .await
        .unwrap();
    });
    let state = ProxyState::new(
        &format!("http://{upstream_address}/v1/chat/completions"),
        "unused-client-key-12345",
        &key,
        false,
    )
    .await
    .unwrap()
    .with_product_connection(connection)
    .with_product_client_keys()
    .unwrap();
    assert!(matches!(
        state.clone().with_routes("[]", |_| None, false).await,
        Err("product client keys cannot be combined with environment routes")
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = |client_key: &str, model: &str| {
        client
            .post(format!("http://{address}/v1/chat/completions"))
            .bearer_auth(client_key)
            .header("content-type", "application/json")
            .body(serde_json::json!({"model":model,"messages":[]}).to_string())
    };
    let client_key = "dashboard-client-key-12345";
    assert_eq!(
        send(client_key, "openrouter/openai/gpt")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        send("dashboard-hashed-key-12345", "openrouter/openai/gpt")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        send(client_key, "other/model")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        send("incorrect-client-key-12345", "openrouter/openai/gpt")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    for (change, reset, expected) in [
        (
            "UPDATE api_keys SET is_active = 0 WHERE id = 'client'",
            "UPDATE api_keys SET is_active = 1 WHERE id = 'client'",
            401,
        ),
        (
            "UPDATE api_keys SET is_banned = 1 WHERE id = 'client'",
            "UPDATE api_keys SET is_banned = 0 WHERE id = 'client'",
            401,
        ),
        (
            "UPDATE api_keys SET revoked_at = '2020-01-01' WHERE id = 'client'",
            "UPDATE api_keys SET revoked_at = NULL WHERE id = 'client'",
            401,
        ),
        (
            "UPDATE api_keys SET expires_at = '2020-01-01' WHERE id = 'client'",
            "UPDATE api_keys SET expires_at = NULL WHERE id = 'client'",
            401,
        ),
        (
            "UPDATE api_keys SET max_requests_per_minute = 1 WHERE id = 'client'",
            "UPDATE api_keys SET max_requests_per_minute = NULL WHERE id = 'client'",
            503,
        ),
        (
            "UPDATE api_keys SET usage_limit_enabled = 1 WHERE id = 'client'",
            "UPDATE api_keys SET usage_limit_enabled = 0 WHERE id = 'client'",
            503,
        ),
        (
            "UPDATE api_keys SET allowed_endpoints = '[\"embeddings\"]' WHERE id = 'client'",
            "UPDATE api_keys SET allowed_endpoints = '[\"chat\"]' WHERE id = 'client'",
            403,
        ),
        (
            "UPDATE api_keys SET allowed_connections = '[\"another-connection\"]' WHERE id = 'client'",
            "UPDATE api_keys SET allowed_connections = '[\"test\"]' WHERE id = 'client'",
            401,
        ),
        (
            "UPDATE api_keys SET allowed_models = '[\"*\"]' WHERE id = 'client'",
            "UPDATE api_keys SET allowed_models = '[\"openrouter/*\"]' WHERE id = 'client'",
            503,
        ),
        (
            "UPDATE api_keys SET blocked_models = '[\"openai/blocked\"]' WHERE id = 'client'",
            "UPDATE api_keys SET blocked_models = '[]' WHERE id = 'client'",
            503,
        ),
        (
            "INSERT INTO domain_budgets VALUES ('client')",
            "DELETE FROM domain_budgets",
            503,
        ),
        (
            "INSERT INTO api_key_token_limits VALUES ('client', 1)",
            "DELETE FROM api_key_token_limits",
            503,
        ),
        (
            "INSERT INTO api_key_quota_limits VALUES ('client', NULL, 1, NULL)",
            "DELETE FROM api_key_quota_limits",
            503,
        ),
        (
            "INSERT INTO api_key_daily_token_limits VALUES ('client')",
            "DELETE FROM api_key_daily_token_limits",
            503,
        ),
        (
            "INSERT INTO key_group_members VALUES ('client')",
            "DELETE FROM key_group_members",
            503,
        ),
        (
            "INSERT INTO budget_assignments VALUES ('budget')",
            "DELETE FROM budget_assignments",
            503,
        ),
        (
            "INSERT INTO model_combo_mappings VALUES (1)",
            "DELETE FROM model_combo_mappings",
            503,
        ),
        (
            "INSERT INTO key_value VALUES ('settings', 'disabledModels', '[\"openrouter/*\"]')",
            "DELETE FROM key_value",
            503,
        ),
        (
            "INSERT INTO combos VALUES ('openrouter/openai/gpt')",
            "DELETE FROM combos",
            403,
        ),
    ] {
        sqlx::query(change).execute(&mut db).await.unwrap();
        assert_eq!(
            send(client_key, "openrouter/openai/gpt")
                .send()
                .await
                .unwrap()
                .status(),
            expected,
            "{change}"
        );
        sqlx::query(reset).execute(&mut db).await.unwrap();
    }
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    server.abort();
    provider.abort();
}

#[tokio::test]
async fn shared_rpm_reservations_coordinate_independent_proxy_instances() {
    let (dir, mut db) = fixture().await;
    sqlx::query(
        "UPDATE provider_connections SET api_key = 'fixture-provider-key' WHERE id = 'test'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO api_keys (id, key) VALUES ('shared', 'shared-dashboard-key-12345')")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO api_key_quota_limits VALUES ('shared', NULL, 4, NULL)")
        .execute(&mut db)
        .await
        .unwrap();
    let sent = Arc::new(AtomicUsize::new(0));
    let count = sent.clone();
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_address = upstream.local_addr().unwrap();
    let provider = tokio::spawn(async move {
        axum::serve(
            upstream,
            Router::new().route(
                "/v1/chat/completions",
                post(move || {
                    let count = count.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        "ok"
                    }
                }),
            ),
        )
        .await
        .unwrap()
    });
    let mut addresses = Vec::new();
    let mut servers = Vec::new();
    for _ in 0..2 {
        let (connection, key) =
            ProductConnection::open(&dir.path().join("storage.sqlite"), "test", None)
                .await
                .unwrap();
        let connection = connection.with_shared_rpm().await.unwrap();
        let state = ProxyState::new(
            &format!("http://{upstream_address}/v1/chat/completions"),
            "unused-client-key-12345",
            &key,
            false,
        )
        .await
        .unwrap()
        .with_product_connection(connection)
        .with_product_client_keys()
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        addresses.push(listener.local_addr().unwrap());
        servers.push(tokio::spawn(async move {
            axum::serve(listener, router(state)).await.unwrap()
        }));
    }
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let statuses: Vec<_> = stream::iter(0..16)
        .map(|index| {
            let client = client.clone();
            let address = addresses[index % addresses.len()];
            async move {
                client
                    .post(format!("http://{address}/v1/chat/completions"))
                    .bearer_auth("shared-dashboard-key-12345")
                    .header("content-type", "application/json")
                    .body(r#"{"model":"openrouter/openai/gpt","messages":[]}"#)
                    .send()
                    .await
                    .unwrap()
                    .status()
            }
        })
        .buffer_unordered(16)
        .collect()
        .await;
    assert_eq!(statuses.iter().filter(|s| **s == 200).count(), 4);
    assert_eq!(statuses.iter().filter(|s| **s == 429).count(), 12);
    assert_eq!(sent.load(Ordering::SeqCst), 4);
    let total: f64 = sqlx::query_scalar("SELECT SUM(consumed) FROM api_key_quota_counters WHERE api_key_id = 'shared' AND dimension_key = 'key-quota:rpm'")
        .fetch_one(&mut db).await.unwrap();
    assert_eq!(total, 4.0);
    // A product-side write in the same table is visible to the Rust gate.
    sqlx::query("DELETE FROM api_key_quota_counters")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("UPDATE api_key_quota_limits SET rpm_limit = 1 WHERE api_key_id = 'shared'")
        .execute(&mut db)
        .await
        .unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    sqlx::query("INSERT INTO api_key_quota_counters VALUES ('shared', 'key-quota:rpm', ?, 1, ?)")
        .bind(now / 60_000)
        .bind(now)
        .execute(&mut db)
        .await
        .unwrap();
    let status = client
        .post(format!("http://{}/v1/chat/completions", addresses[0]))
        .bearer_auth("shared-dashboard-key-12345")
        .header("content-type", "application/json")
        .body(r#"{"model":"openrouter/openai/gpt","messages":[]}"#)
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 429);
    assert_eq!(sent.load(Ordering::SeqCst), 4);
    for server in servers {
        server.abort();
    }
    provider.abort();
}

// Descriptive benchmark on an isolated mock: no absolute latency threshold is
// meaningful on a shared runner. The two cases share the same provider process.
#[tokio::test]
#[ignore = "run explicitly in release mode for descriptive performance"]
async fn benchmark_product_guard() {
    let (dir, mut db) = fixture().await;
    sqlx::query("INSERT INTO api_keys (id, key) VALUES ('bench', 'client-key-123456789')")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE provider_connections SET api_key = 'fixture-provider-key' WHERE id = 'test'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    let (connection, key) =
        ProductConnection::open(&dir.path().join("storage.sqlite"), "test", None)
            .await
            .unwrap();
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_address = upstream.local_addr().unwrap();
    let provider = tokio::spawn(async move {
        axum::serve(
            upstream,
            Router::new().route("/v1/chat/completions", post(|| async { "ok" })),
        )
        .await
        .unwrap()
    });
    let upstream_url = format!("http://{upstream_address}/v1/chat/completions");
    let plain = ProxyState::new(&upstream_url, "client-key-123456789", &key, false)
        .await
        .unwrap();
    let guarded = ProxyState::new(&upstream_url, "client-key-123456789", &key, false)
        .await
        .unwrap()
        .with_product_connection(connection.clone());
    let dashboard = ProxyState::new(&upstream_url, "client-key-123456789", &key, false)
        .await
        .unwrap()
        .with_product_connection(connection.clone())
        .with_product_client_keys()
        .unwrap();
    let shared = ProxyState::new(&upstream_url, "client-key-123456789", &key, false)
        .await
        .unwrap()
        .with_product_connection(connection.with_shared_rpm().await.unwrap())
        .with_product_client_keys()
        .unwrap();
    let mut servers = Vec::new();
    for (label, state) in [
        ("baseline", plain),
        ("product-sqlite", guarded),
        ("dashboard-policy", dashboard),
        ("shared-rpm", shared),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        servers.push(tokio::spawn(async move {
            axum::serve(listener, router(state)).await.unwrap()
        }));
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = format!("http://{address}/v1/chat/completions");
        let samples: Vec<u128> = stream::iter(0..220)
            .map(|_| {
                let client = client.clone();
                let url = url.clone();
                async move {
                    let start = std::time::Instant::now();
                    let response = client
                        .post(url)
                        .bearer_auth("client-key-123456789")
                        .header("content-type", "application/json")
                        .body(r#"{"model":"openrouter/openai/gpt","messages":[]}"#)
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(response.status(), 200);
                    response.bytes().await.unwrap();
                    start.elapsed().as_micros()
                }
            })
            .buffered(16)
            .collect()
            .await;
        let mut measured = samples[20..].to_vec();
        measured.sort_unstable();
        println!(
            "{label}: n={} concurrency=16 p50={}us p95={}us",
            measured.len(),
            measured[measured.len() / 2],
            measured[measured.len() * 95 / 100]
        );
    }
    for server in servers {
        server.abort();
    }
    provider.abort();
}
