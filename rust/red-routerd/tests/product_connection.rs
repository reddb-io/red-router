use axum::{routing::post, Router};
use futures_util::{stream, StreamExt};
use red_routerd::{product::ProductConnection, router, ProxyState};
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
    sqlx::query("CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, auth_type TEXT, is_active INTEGER, api_key TEXT, updated_at TEXT NOT NULL)")
        .execute(&mut db).await.unwrap();
    sqlx::query(
        "INSERT INTO provider_connections VALUES ('test', 'openrouter', 'apikey', 1, ?, 'a')",
    )
    .bind(ENCRYPTED)
    .execute(&mut db)
    .await
    .unwrap();
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
            .body(r#"{"model":"test","messages":[]}"#)
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

// Descriptive benchmark on an isolated mock: no absolute latency threshold is
// meaningful on a shared runner. The two cases share the same provider process.
#[tokio::test]
#[ignore = "run explicitly in release mode for descriptive performance"]
async fn benchmark_product_guard() {
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
        .with_product_connection(connection);
    let mut servers = Vec::new();
    for (label, state) in [("baseline", plain), ("product-sqlite", guarded)] {
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
                        .body(r#"{"model":"test","messages":[]}"#)
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
