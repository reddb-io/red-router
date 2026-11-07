use axum::{
    http::{header, HeaderMap},
    routing::post,
    Router,
};
use red_routerd::{
    control_plane::ControlPlane,
    router,
    storage::{Backend, Database},
    ProxyState,
};
use std::sync::Arc;
use tempfile::TempDir;
use url::Url;

const ADMIN_KEY: &str = "fixture-admin-key-1234567890-abcdef";
const CLIENT_KEY: &str = "fixture-client-key-1234567890";
const RUST_CLIENT_KEY: &str = "rust-owned-client-key-1234567890";
const STORAGE_KEY: &str = "fixture-storage-key-1234567890";

async fn provider(
    expected_key: &'static str,
    label: &'static str,
) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap| async move {
            assert_eq!(
                headers["authorization"].to_str().unwrap(),
                format!("Bearer {expected_key}")
            );
            label
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1/chat/completions"), task)
}

async fn gateway(control: ControlPlane) -> (String, tokio::task::JoinHandle<()>) {
    let state = ProxyState::new(
        "http://127.0.0.1:1/v1/chat/completions",
        CLIENT_KEY,
        "placeholder",
        true,
    )
    .await
    .unwrap()
    .with_control_plane(control);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    (format!("http://{address}"), task)
}

async fn chat(client: &reqwest::Client, base: &str, key: &str) -> reqwest::Response {
    client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(key)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(r#"{"model":"fixture-model","messages":[]}"#)
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn rust_control_plane_persists_redacts_and_live_reloads_providers() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("control.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (first_url, first_task) = provider("first-provider-secret", "first").await;
    let (second_url, second_task) = provider("second-provider-secret", "second").await;
    let (base, gateway_task) = gateway(control.clone()).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .get(format!("{base}/readyz"))
            .send()
            .await
            .unwrap()
            .status(),
        503
    );
    assert_eq!(chat(&client, &base, CLIENT_KEY).await.status(), 503);
    assert_eq!(
        client
            .get(format!("{base}/api/admin/providers"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );

    let first_response = client
        .put(format!("{base}/api/admin/providers/first"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "provider":"openai",
                "upstream_url":first_url,
                "api_key":"first-provider-secret"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(first_response.status(), 200);
    assert!(!first_response
        .text()
        .await
        .unwrap()
        .contains("first-provider-secret"));
    assert_eq!(
        chat(&client, &base, CLIENT_KEY).await.text().await.unwrap(),
        "first"
    );

    let key_response = client
        .put(format!("{base}/api/admin/client-keys/agent-fleet"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "label":"Agent fleet",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["fixture-model"],
                "allowed_provider_ids":["first"],
                "max_concurrent_requests":32,
                "max_requests_per_minute":600
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(key_response.status(), 200);
    let key_body = key_response.text().await.unwrap();
    assert!(!key_body.contains(RUST_CLIENT_KEY));
    assert!(!key_body.contains("key_hash"));
    let update_key = |provider: &str, expiry: Option<u64>| {
        serde_json::json!({
            "label":"Agent fleet",
            "expires_at_unix":expiry,
            "scopes":["inference:chat"],
            "allowed_endpoints":["chat"],
            "allowed_models":["fixture-model"],
            "allowed_provider_ids":[provider],
            "max_concurrent_requests":32,
            "max_requests_per_minute":600
        })
        .to_string()
    };
    assert_eq!(chat(&client, &base, CLIENT_KEY).await.status(), 401);
    assert_eq!(
        chat(&client, &base, RUST_CLIENT_KEY)
            .await
            .text()
            .await
            .unwrap(),
        "first"
    );
    assert_eq!(
        client
            .post(format!("{base}/v1/embeddings"))
            .bearer_auth(RUST_CLIENT_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(r#"{"model":"fixture-model","input":"hello"}"#)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/agent-fleet"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(update_key("first", Some(1)))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(chat(&client, &base, RUST_CLIENT_KEY).await.status(), 401);
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/agent-fleet"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(update_key("first", None))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth(RUST_CLIENT_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(r#"{"model":"other-model","messages":[]}"#)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );

    let second_response = client
        .put(format!("{base}/api/admin/providers/second"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "provider":"openrouter",
                "upstream_url":second_url,
                "api_key":"second-provider-secret"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(second_response.status(), 200);
    assert_eq!(chat(&client, &base, RUST_CLIENT_KEY).await.status(), 403);
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/agent-fleet"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(update_key("second", None))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        chat(&client, &base, RUST_CLIENT_KEY)
            .await
            .text()
            .await
            .unwrap(),
        "second"
    );

    let listing = client
        .get(format!("{base}/api/admin/providers"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(listing.contains("\"has_credential\":true"));
    assert!(!listing.contains("first-provider-secret"));
    assert!(!listing.contains("second-provider-secret"));
    let stored = database.providers().await.unwrap();
    assert!(stored
        .iter()
        .all(|row| row.credential_ciphertext.starts_with("rr:v1:")));
    assert!(stored
        .iter()
        .all(|row| !row.credential_ciphertext.contains("provider-secret")));
    let stored_keys = database.client_keys().await.unwrap();
    assert_eq!(stored_keys.len(), 1);
    assert_eq!(stored_keys[0].key_hash.len(), 64);
    assert!(!stored_keys[0].key_hash.contains(RUST_CLIENT_KEY));
    let key_listing = client
        .get(format!("{base}/api/admin/client-keys"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(key_listing.contains("Agent fleet"));
    assert!(!key_listing.contains(RUST_CLIENT_KEY));
    assert!(!key_listing.contains("key_hash"));

    assert_eq!(
        client
            .delete(format!("{base}/api/admin/providers/second"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    assert_eq!(chat(&client, &base, RUST_CLIENT_KEY).await.status(), 403);
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/agent-fleet"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(update_key("first", None))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        chat(&client, &base, RUST_CLIENT_KEY)
            .await
            .text()
            .await
            .unwrap(),
        "first"
    );

    gateway_task.abort();
    let restarted = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    assert_eq!(
        chat(&client, &restarted_base, RUST_CLIENT_KEY)
            .await
            .text()
            .await
            .unwrap(),
        "first"
    );
    assert_eq!(
        client
            .delete(format!(
                "{restarted_base}/api/admin/client-keys/agent-fleet"
            ))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    assert_eq!(
        chat(&client, &restarted_base, RUST_CLIENT_KEY)
            .await
            .status(),
        401
    );
    assert_eq!(
        client
            .delete(format!("{restarted_base}/api/admin/providers/first"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    assert_eq!(
        client
            .get(format!("{restarted_base}/readyz"))
            .send()
            .await
            .unwrap()
            .status(),
        503
    );
    assert_eq!(
        chat(&client, &restarted_base, RUST_CLIENT_KEY)
            .await
            .status(),
        401
    );

    restarted_task.abort();
    first_task.abort();
    second_task.abort();
    database.close().await.unwrap();
}
