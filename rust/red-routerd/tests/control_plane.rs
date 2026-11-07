use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, StatusCode},
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

async fn failing_provider(expected_key: &'static str) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap| async move {
            assert_eq!(
                headers["authorization"].to_str().unwrap(),
                format!("Bearer {expected_key}")
            );
            (StatusCode::SERVICE_UNAVAILABLE, "retry")
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1/chat/completions"), task)
}

async fn held_streaming_provider(
    expected_key: &'static str,
    label: &'static str,
    release: Arc<tokio::sync::Semaphore>,
) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap| {
            let release = release.clone();
            async move {
                assert_eq!(
                    headers["authorization"].to_str().unwrap(),
                    format!("Bearer {expected_key}")
                );
                let body = futures_util::stream::once(async move {
                    let _release = release.acquire().await.unwrap();
                    Ok::<Bytes, std::convert::Infallible>(Bytes::from_static(label.as_bytes()))
                });
                axum::http::Response::builder()
                    .header(header::CONTENT_TYPE, "application/octet-stream")
                    .body(Body::from_stream(body))
                    .unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1/chat/completions"), task)
}

async fn embeddings_provider(expected_key: &'static str) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/v1/embeddings",
        post(move |headers: HeaderMap| async move {
            assert_eq!(
                headers["authorization"].to_str().unwrap(),
                format!("Bearer {expected_key}")
            );
            "embedding-ok"
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1/embeddings"), task)
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
    chat_model(client, base, key, "fixture-model").await
}

async fn chat_model(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    model: &str,
) -> reqwest::Response {
    client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(key)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(serde_json::json!({"model":model,"messages":[]}).to_string())
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn rust_control_plane_routes_durable_non_chat_protocols() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("protocols.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (provider_url, provider_task) = embeddings_provider("embedding-secret").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/embedding-provider"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "provider":"openai",
                    "upstream_url":provider_url,
                    "api_key":"embedding-secret"
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/embedding-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Embedding client",
                    "api_key":RUST_CLIENT_KEY,
                    "scopes":["inference:embeddings","inference:chat"],
                    "allowed_endpoints":["embeddings","chat"],
                    "allowed_models":["embedding-combo","text-embedding-3-small"],
                    "allowed_provider_ids":["embedding-provider"]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/embedding-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "protocol":"openai-embeddings",
                    "strategy":"priority",
                    "fallback":true,
                    "targets":[{
                        "provider_id":"embedding-provider",
                        "model":"text-embedding-3-small"
                    }]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let response = client
        .post(format!("{base}/v1/embeddings"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(serde_json::json!({"model":"embedding-combo","input":"hello"}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().await.unwrap(), "embedding-ok");
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "embedding-combo")
            .await
            .status(),
        404
    );

    gateway_task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn rust_control_plane_persists_and_live_reloads_combo_routes() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("combos.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (first_url, first_task) = provider("combo-first-secret", "combo-first").await;
    let (second_url, second_task) = provider("combo-second-secret", "combo-second").await;
    let (failing_url, failing_task) = failing_provider("combo-failing-secret").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    for (id, url, secret) in [
        ("first", first_url, "combo-first-secret"),
        ("second", second_url, "combo-second-secret"),
        ("failing", failing_url, "combo-failing-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .header(header::CONTENT_TYPE.as_str(), "application/json")
                .body(
                    serde_json::json!({
                        "provider":"openai-compatible",
                        "upstream_url":url,
                        "api_key":secret
                    })
                    .to_string()
                )
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/combo-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Combo client",
                    "api_key":RUST_CLIENT_KEY,
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["agent-combo","upstream-model"],
                    "allowed_provider_ids":["first"]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/agent-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"priority",
                    "fallback":true,
                    "targets":[{"provider_id":"first","model":"upstream-model"}]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "agent-combo")
            .await
            .text()
            .await
            .unwrap(),
        "combo-first"
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/agent-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"round-robin",
                    "fallback":true,
                    "targets":[{"provider_id":"second","model":"upstream-model"}]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "agent-combo")
            .await
            .status(),
        403
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/combo-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Combo client",
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["agent-combo","upstream-model"],
                    "allowed_provider_ids":["second"]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "agent-combo")
            .await
            .text()
            .await
            .unwrap(),
        "combo-second"
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/combo-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Combo client",
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["agent-combo","upstream-model"],
                    "allowed_provider_ids":["first","second"]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let cost_combo = client
        .put(format!("{base}/api/admin/combos/agent-combo"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "strategy":"cost-optimized",
                "fallback":true,
                "targets":[
                    {
                        "provider_id":"first",
                        "model":"upstream-model",
                        "input_cost_per_million":5.0,
                        "output_cost_per_million":15.0
                    },
                    {
                        "provider_id":"second",
                        "model":"upstream-model",
                        "input_cost_per_million":0.5,
                        "output_cost_per_million":1.5
                    }
                ]
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(cost_combo.status(), 200);
    let cost_combo: serde_json::Value =
        serde_json::from_str(&cost_combo.text().await.unwrap()).unwrap();
    assert_eq!(cost_combo["targets"][1]["input_cost_per_million"], 0.5);
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "agent-combo")
            .await
            .text()
            .await
            .unwrap(),
        "combo-second"
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/agent-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"context-optimized",
                    "fallback":true,
                    "targets":[
                        {
                            "provider_id":"first",
                            "model":"upstream-model",
                            "context_window_tokens":128000
                        },
                        {
                            "provider_id":"second",
                            "model":"upstream-model",
                            "context_window_tokens":1000000
                        }
                    ]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "agent-combo")
            .await
            .text()
            .await
            .unwrap(),
        "combo-second"
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/agent-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"cost-optimized",
                    "fallback":true,
                    "targets":[{"provider_id":"first","model":"upstream-model"}]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/agent-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"weighted",
                    "fallback":true,
                    "targets":[
                        {"provider_id":"first","model":"upstream-model","weight":50},
                        {"provider_id":"second","model":"upstream-model","weight":50}
                    ]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let mut saw_first = false;
    let mut saw_second = false;
    for _ in 0..20 {
        let selected = chat_model(&client, &base, RUST_CLIENT_KEY, "agent-combo")
            .await
            .text()
            .await
            .unwrap();
        saw_first |= selected == "combo-first";
        saw_second |= selected == "combo-second";
    }
    assert!(saw_first && saw_second);
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/agent-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"strict-random",
                    "fallback":true,
                    "targets":[
                        {"provider_id":"first","model":"upstream-model"},
                        {"provider_id":"second","model":"upstream-model"}
                    ]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let mut strict_deck = Vec::new();
    for _ in 0..4 {
        strict_deck.push(
            chat_model(&client, &base, RUST_CLIENT_KEY, "agent-combo")
                .await
                .text()
                .await
                .unwrap(),
        );
    }
    assert!(strict_deck.windows(2).all(|pair| pair[0] != pair[1]));
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/agent-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"fill-first",
                    "fallback":true,
                    "targets":[
                        {"provider_id":"first","model":"upstream-model"},
                        {"provider_id":"second","model":"upstream-model"}
                    ]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "agent-combo")
            .await
            .text()
            .await
            .unwrap(),
        "combo-first"
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/agent-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"priority",
                    "fallback":true,
                    "targets":[
                        {"provider_id":"failing","model":"upstream-model"},
                        {"provider_id":"second","model":"upstream-model"}
                    ]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/combo-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Combo client",
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["agent-combo","upstream-model"],
                    "allowed_provider_ids":["failing","second"]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "agent-combo")
            .await
            .text()
            .await
            .unwrap(),
        "combo-second"
    );
    let listing = client
        .get(format!("{base}/api/admin/combos"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(listing.contains("agent-combo"));
    assert!(listing.contains("second"));
    assert!(!listing.contains("combo-second-secret"));

    gateway_task.abort();
    let restarted = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    assert_eq!(
        chat_model(&client, &restarted_base, RUST_CLIENT_KEY, "agent-combo")
            .await
            .text()
            .await
            .unwrap(),
        "combo-second"
    );
    assert_eq!(
        client
            .get(format!("{restarted_base}/api/admin/provider-health"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let health = client
        .get(format!("{restarted_base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let health: serde_json::Value = serde_json::from_str(&health).unwrap();
    let failing_health = health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "failing")
        .unwrap();
    assert_eq!(failing_health["state"], "open");
    assert_eq!(failing_health["failure_count"], 2);
    assert_eq!(
        client
            .put(format!(
                "{restarted_base}/api/admin/client-keys/combo-client"
            ))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Combo client",
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["agent-combo","upstream-model"],
                    "allowed_provider_ids":["failing"]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let blocked = chat_model(&client, &restarted_base, RUST_CLIENT_KEY, "agent-combo").await;
    assert_eq!(blocked.status(), 503);
    assert!(blocked.headers().get(header::RETRY_AFTER).is_some());
    assert_eq!(
        client
            .put(format!(
                "{restarted_base}/api/admin/client-keys/combo-client"
            ))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Combo client",
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["agent-combo","upstream-model"],
                    "allowed_provider_ids":["failing","second"]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        chat_model(&client, &restarted_base, RUST_CLIENT_KEY, "agent-combo")
            .await
            .text()
            .await
            .unwrap(),
        "combo-second"
    );
    let health = client
        .get(format!("{restarted_base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let health: serde_json::Value = serde_json::from_str(&health).unwrap();
    assert_eq!(
        health["provider_health"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["provider_id"] == "failing")
            .unwrap()["failure_count"],
        2
    );
    assert_eq!(
        client
            .delete(format!(
                "{restarted_base}/api/admin/provider-health/failing"
            ))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    let reset_health = client
        .get(format!("{restarted_base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let reset_health: serde_json::Value = serde_json::from_str(&reset_health).unwrap();
    let reset_failing = reset_health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "failing")
        .unwrap();
    assert_eq!(reset_failing["state"], "closed");
    assert_eq!(reset_failing["failure_count"], 0);
    assert_eq!(
        client
            .delete(format!("{restarted_base}/api/admin/combos/agent-combo"))
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
        chat_model(&client, &restarted_base, RUST_CLIENT_KEY, "agent-combo")
            .await
            .status(),
        404
    );

    restarted_task.abort();
    first_task.abort();
    second_task.abort();
    failing_task.abort();
    database.close().await.unwrap();
}

#[tokio::test]
async fn rust_control_plane_balances_shared_stream_load_across_snapshot_reload() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("load-balancing.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let (held_url, held_task) =
        held_streaming_provider("combo-held-secret", "combo-held", release.clone()).await;
    let (idle_url, idle_task) = provider("combo-idle-secret", "combo-idle").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    for (id, upstream_url, api_key) in [
        ("held", held_url, "combo-held-secret"),
        ("idle", idle_url, "combo-idle-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .header(header::CONTENT_TYPE.as_str(), "application/json")
                .body(
                    serde_json::json!({
                        "provider":"openai-compatible",
                        "upstream_url":upstream_url,
                        "api_key":api_key
                    })
                    .to_string(),
                )
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/load-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Load balancing client",
                    "api_key":RUST_CLIENT_KEY,
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["load-combo","upstream-model"],
                    "allowed_provider_ids":["held","idle"]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let configure = |strategy: &'static str| {
        client
            .put(format!("{base}/api/admin/combos/load-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":strategy,
                    "fallback":false,
                    "targets":[
                        {"provider_id":"held","model":"upstream-model"},
                        {"provider_id":"idle","model":"upstream-model"}
                    ]
                })
                .to_string(),
            )
            .send()
    };
    assert_eq!(configure("least-used").await.unwrap().status(), 200);

    // Keep the first provider body open. Its load guard must remain active after
    // response headers, so another agent is sent to the idle provider.
    let held_response = chat_model(&client, &base, RUST_CLIENT_KEY, "load-combo").await;
    assert_eq!(held_response.status(), 200);
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "load-combo")
            .await
            .text()
            .await
            .unwrap(),
        "combo-idle"
    );

    // A live dashboard reload creates a new route snapshot. Provider load is
    // shared independently of that snapshot, and P2C must still avoid the busy
    // stream when comparing its two candidates.
    assert_eq!(configure("p2c").await.unwrap().status(), 200);
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "load-combo")
            .await
            .text()
            .await
            .unwrap(),
        "combo-idle"
    );

    release.add_permits(1);
    assert_eq!(held_response.text().await.unwrap(), "combo-held");

    gateway_task.abort();
    held_task.abort();
    idle_task.abort();
    database.close().await.unwrap();
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
            .get(format!("{restarted_base}/readyz"))
            .send()
            .await
            .unwrap()
            .status(),
        503
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
