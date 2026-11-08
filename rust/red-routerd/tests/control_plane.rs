use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use red_routerd::{
    control_plane::ControlPlane,
    router,
    storage::{Backend, Database},
    ProxyState,
};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;
use url::Url;

const ADMIN_KEY: &str = "fixture-admin-key-1234567890-abcdef";
const CLIENT_KEY: &str = "fixture-client-key-1234567890";
const RUST_CLIENT_KEY: &str = "rust-owned-client-key-1234567890";
const STORAGE_KEY: &str = "fixture-storage-key-1234567890";
const OIDC_PRIVATE_KEY: &str = r#"-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgWTFfCGljY6aw3Hrt
kHmPRiazukxPLb6ilpRAewjW8nihRANCAATDskChT+Altkm9X7MI69T3IUmrQU0L
950IxEzvw/x5BMEINRMrXLBJhqzO9Bm+d6JbqA21YQmd1Kt4RzLJR1W+
-----END PRIVATE KEY-----"#;

fn oidc_token(kid: &str, audience: &str, role: &str) -> String {
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(kid.to_owned());
    encode(
        &header,
        &serde_json::json!({
            "iss":"https://issuer.example",
            "aud":audience,
            "sub":"operator-123",
            "email":"operator@example.com",
            "email_verified":true,
            "org_role":role,
            "exp":SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs() + 300
        }),
        &EncodingKey::from_ec_pem(OIDC_PRIVATE_KEY.as_bytes()).unwrap(),
    )
    .unwrap()
}

fn oidc_browser_token(nonce: &str) -> String {
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some("ec01".to_owned());
    encode(
        &header,
        &serde_json::json!({
            "iss":"https://issuer.example",
            "aud":"red-router-dashboard",
            "sub":"operator-123",
            "email":"operator@example.com",
            "email_verified":true,
            "org_role":"operator",
            "nonce":nonce,
            "exp":SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs() + 300
        }),
        &EncodingKey::from_ec_pem(OIDC_PRIVATE_KEY.as_bytes()).unwrap(),
    )
    .unwrap()
}

async fn oidc_jwks() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let app = Router::new().route(
        "/jwks",
        get(move || {
            let observed = observed.clone();
            async move {
                observed.fetch_add(1, Ordering::SeqCst);
                Json(serde_json::json!({"keys":[{
                    "kty":"EC",
                    "crv":"P-256",
                    "x":"w7JAoU_gJbZJvV-zCOvU9yFJq0FNC_edCMRM78P8eQQ",
                    "y":"wQg1EytcsEmGrM70Gb53oluoDbVhCZ3Uq3hHMslHVb4",
                    "kid":"ec01",
                    "alg":"ES256",
                    "use":"sig"
                }]}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/jwks"), requests, task)
}

async fn oidc_token_server(
    nonce: Arc<tokio::sync::RwLock<String>>,
) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/token",
        post(move |headers: HeaderMap, body: String| {
            let nonce = nonce.clone();
            async move {
                assert_eq!(
                    headers[header::CONTENT_TYPE].to_str().unwrap(),
                    "application/x-www-form-urlencoded"
                );
                let fields: std::collections::HashMap<_, _> =
                    url::form_urlencoded::parse(body.as_bytes())
                        .into_owned()
                        .collect();
                assert_eq!(
                    fields.get("grant_type").map(String::as_str),
                    Some("authorization_code")
                );
                assert_eq!(fields.get("code").map(String::as_str), Some("fixture-code"));
                assert_eq!(
                    fields.get("client_id").map(String::as_str),
                    Some("red-router-dashboard")
                );
                assert_eq!(
                    fields.get("client_secret").map(String::as_str),
                    Some("browser-secret")
                );
                assert!(fields
                    .get("code_verifier")
                    .is_some_and(|value| value.len() >= 43));
                let nonce = nonce.read().await.clone();
                Json(serde_json::json!({"id_token":oidc_browser_token(&nonce)}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}"), task)
}

fn response_cookie(response: &reqwest::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| {
            value
                .split(';')
                .next()
                .filter(|pair| pair.starts_with(&format!("{name}=")))
                .map(str::to_owned)
        })
}

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

async fn set_provider_quota(
    client: &reqwest::Client,
    base: &str,
    provider_id: &str,
    body: serde_json::Value,
) -> StatusCode {
    client
        .put(format!("{base}/api/admin/provider-quotas/{provider_id}"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap()
        .status()
}

async fn set_combo_strategy(client: &reqwest::Client, base: &str, strategy: &str) -> StatusCode {
    client
        .put(format!("{base}/api/admin/combos/quota-combo"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "strategy":strategy,
                "fallback":true,
                "targets":[
                    {"provider_id":"quota-first","model":"upstream-model"},
                    {"provider_id":"quota-second","model":"upstream-model"}
                ]
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn rust_control_plane_persists_and_enforces_signed_oidc_admin_authentication() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("oidc.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (jwks_uri, jwks_requests, jwks_task) = oidc_jwks().await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .put(format!("{base}/api/admin/oidc"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "enabled":true,
                    "issuer":"https://issuer.example",
                    "audience":"red-router-admin",
                    "jwks_uri":jwks_uri,
                    "required_claims":{"org_role":["owner","operator"]},
                    "allowed_subjects":["operator@example.com"]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(jwks_requests.load(Ordering::SeqCst), 1);

    let valid = oidc_token("ec01", "red-router-admin", "operator");
    assert_eq!(
        client
            .get(format!("{base}/api/admin/providers"))
            .bearer_auth(&valid)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for denied in [
        oidc_token("ec01", "other-audience", "operator"),
        oidc_token("ec01", "red-router-admin", "viewer"),
        oidc_token("unknown-key", "red-router-admin", "operator"),
    ] {
        assert_eq!(
            client
                .get(format!("{base}/api/admin/providers"))
                .bearer_auth(denied)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    // Unknown key IDs do not turn the management endpoint into an unbounded
    // attacker-controlled JWKS refresh loop.
    assert_eq!(jwks_requests.load(Ordering::SeqCst), 1);

    gateway_task.abort();
    let restarted = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    assert_eq!(
        client
            .get(format!("{restarted_base}/api/admin/providers"))
            .bearer_auth(&valid)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(jwks_requests.load(Ordering::SeqCst), 2);
    assert_eq!(
        client
            .delete(format!("{restarted_base}/api/admin/oidc"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        client
            .get(format!("{restarted_base}/api/admin/providers"))
            .bearer_auth(valid)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );

    restarted_task.abort();
    jwks_task.abort();
}

#[tokio::test]
async fn rust_control_plane_owns_oidc_pkce_login_and_csrf_bound_admin_sessions() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("oidc-browser.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (jwks_uri, _, jwks_task) = oidc_jwks().await;
    let nonce = Arc::new(tokio::sync::RwLock::new(String::new()));
    let (issuer_server, issuer_task) = oidc_token_server(nonce.clone()).await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    let configured = client
        .put(format!("{base}/api/admin/oidc"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "enabled":true,
                "issuer":"https://issuer.example",
                "audience":"red-router-admin",
                "jwks_uri":jwks_uri,
                "required_claims":{"org_role":["operator"]},
                "allowed_subjects":["operator@example.com"],
                "browser":{
                    "public_origin":base.clone(),
                    "client_id":"red-router-dashboard",
                    "client_secret":"browser-secret",
                    "authorization_endpoint":format!("{issuer_server}/authorize"),
                    "token_endpoint":format!("{issuer_server}/token"),
                    "scopes":["openid","profile","email"]
                }
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(configured.status(), StatusCode::OK);
    let configured_body: serde_json::Value =
        serde_json::from_str(&configured.text().await.unwrap()).unwrap();
    assert_eq!(
        configured_body["oidc"]["browser"]["has_client_secret"],
        true
    );
    assert!(!configured_body.to_string().contains("browser-secret"));
    let stored_browser = database.oidc_browser_config().await.unwrap().unwrap();
    assert_ne!(stored_browser.client_secret_ciphertext, "browser-secret");

    let login = client
        .get(format!("{base}/api/auth/oidc/login"))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::TEMPORARY_REDIRECT);
    let flow_cookie = response_cookie(&login, "redrouter_oidc_flow").unwrap();
    let authorization = Url::parse(login.headers()[header::LOCATION].to_str().unwrap()).unwrap();
    let parameters: std::collections::HashMap<_, _> =
        authorization.query_pairs().into_owned().collect();
    assert_eq!(
        parameters.get("response_type").map(String::as_str),
        Some("code")
    );
    assert_eq!(
        parameters.get("code_challenge_method").map(String::as_str),
        Some("S256")
    );
    assert!(parameters
        .get("code_challenge")
        .is_some_and(|challenge| challenge.len() == 43));
    let state = parameters.get("state").unwrap().clone();
    *nonce.write().await = parameters.get("nonce").unwrap().clone();

    let callback = client
        .get(format!(
            "{base}/api/auth/oidc/callback?code=fixture-code&state={state}"
        ))
        .header(header::COOKIE, flow_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        callback.headers()[header::LOCATION].to_str().unwrap(),
        format!("{base}/dashboard")
    );
    let session_cookie = response_cookie(&callback, "redrouter_admin_session").unwrap();
    let csrf_cookie = response_cookie(&callback, "redrouter_admin_csrf").unwrap();
    let csrf = csrf_cookie.split_once('=').unwrap().1.to_owned();
    let cookies = format!("{session_cookie}; {csrf_cookie}");

    assert_eq!(
        client
            .get(format!("{base}/api/admin/providers"))
            .header(header::COOKIE, &cookies)
            .header("x-red-router-csrf", &csrf)
            .header(header::ORIGIN, &base)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for denied in [
        client
            .get(format!("{base}/api/admin/providers"))
            .header(header::COOKIE, &cookies)
            .header(header::ORIGIN, &base)
            .send()
            .await
            .unwrap(),
        client
            .get(format!("{base}/api/admin/providers"))
            .header(header::COOKIE, &cookies)
            .header("x-red-router-csrf", &csrf)
            .header(header::ORIGIN, "https://attacker.example")
            .send()
            .await
            .unwrap(),
    ] {
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    }

    let logout = client
        .post(format!("{base}/api/auth/logout"))
        .send()
        .await
        .unwrap();
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        logout.headers().get_all(header::SET_COOKIE).iter().count(),
        3
    );

    gateway_task.abort();
    issuer_task.abort();
    jwks_task.abort();
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
    assert_eq!(
        cost_combo["combo"]["targets"][1]["input_cost_per_million"],
        0.5
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
async fn rust_control_plane_persists_and_clears_last_known_good_target() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("lkgp.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (first_url, first_task) = provider("lkgp-first-secret", "lkgp-first").await;
    let (second_url, second_task) = provider("lkgp-second-secret", "lkgp-second").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    for (id, upstream_url, api_key) in [
        ("lkgp-first", first_url, "lkgp-first-secret"),
        ("lkgp-second", second_url, "lkgp-second-secret"),
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
            .put(format!("{base}/api/admin/client-keys/lkgp-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"LKGP client",
                    "api_key":RUST_CLIENT_KEY,
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["lkgp-combo","upstream-model"],
                    "allowed_provider_ids":["lkgp-second"]
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
        client
            .put(format!("{base}/api/admin/combos/lkgp-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"lkgp",
                    "fallback":true,
                    "targets":[
                        {"provider_id":"lkgp-first","model":"upstream-model"},
                        {"provider_id":"lkgp-second","model":"upstream-model"}
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
        chat_model(&client, &base, RUST_CLIENT_KEY, "lkgp-combo")
            .await
            .text()
            .await
            .unwrap(),
        "lkgp-second"
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/lkgp-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"LKGP client",
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["lkgp-combo","upstream-model"],
                    "allowed_provider_ids":["lkgp-first","lkgp-second"]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let combos = client
        .get(format!("{base}/api/admin/combos"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let combos: serde_json::Value = serde_json::from_str(&combos).unwrap();
    assert_eq!(
        combos["combos"][0]["last_known_good"]["provider_id"],
        "lkgp-second"
    );

    gateway_task.abort();
    let restarted = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    assert_eq!(
        chat_model(&client, &restarted_base, RUST_CLIENT_KEY, "lkgp-combo")
            .await
            .text()
            .await
            .unwrap(),
        "lkgp-second"
    );
    let (failed_second_url, failed_second_task) = failing_provider("lkgp-second-secret").await;
    assert_eq!(
        client
            .put(format!("{restarted_base}/api/admin/providers/lkgp-second"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "provider":"openai-compatible",
                    "upstream_url":failed_second_url,
                    "api_key":"lkgp-second-secret"
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
        chat_model(&client, &restarted_base, RUST_CLIENT_KEY, "lkgp-combo")
            .await
            .text()
            .await
            .unwrap(),
        "lkgp-first"
    );
    assert_eq!(
        database.route_pins().await.unwrap()[0].provider_id,
        "lkgp-first"
    );
    assert_eq!(
        client
            .delete(format!("{restarted_base}/api/admin/combos/lkgp-combo/lkgp"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    assert!(database.route_pins().await.unwrap().is_empty());
    assert_eq!(
        chat_model(&client, &restarted_base, RUST_CLIENT_KEY, "lkgp-combo")
            .await
            .text()
            .await
            .unwrap(),
        "lkgp-first"
    );
    assert_eq!(
        client
            .delete(format!("{restarted_base}/api/admin/combos/lkgp-combo"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    assert!(database.route_pins().await.unwrap().is_empty());

    restarted_task.abort();
    first_task.abort();
    second_task.abort();
    failed_second_task.abort();
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

#[tokio::test]
async fn rust_control_plane_applies_live_quota_strategies_without_route_reloads() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("quota-routing.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (first_url, first_task) = provider("quota-first-secret", "quota-first").await;
    let (second_url, second_task) = provider("quota-second-secret", "quota-second").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    for (id, upstream_url, api_key) in [
        ("quota-first", first_url, "quota-first-secret"),
        ("quota-second", second_url, "quota-second-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .header(header::CONTENT_TYPE.as_str(), "application/json")
                .body(
                    serde_json::json!({
                        "provider":"openai",
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
            .put(format!("{base}/api/admin/client-keys/quota-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Quota client",
                    "api_key":RUST_CLIENT_KEY,
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["quota-combo","upstream-model"],
                    "allowed_provider_ids":["quota-first","quota-second"]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );

    let healthy = || {
        serde_json::json!({
            "session":{"remaining_percent":90.0},
            "weekly":{"remaining_percent":80.0},
            "ttl_seconds":600
        })
    };
    let exhausted = || serde_json::json!({"limit_reached":true,"ttl_seconds":600});
    for strategy in ["reset-aware", "headroom", "quota-weighted"] {
        assert_eq!(
            set_provider_quota(&client, &base, "quota-first", exhausted()).await,
            200
        );
        assert_eq!(
            set_provider_quota(&client, &base, "quota-second", healthy()).await,
            200
        );
        assert_eq!(set_combo_strategy(&client, &base, strategy).await, 200);
        assert_eq!(
            chat_model(&client, &base, RUST_CLIENT_KEY, "quota-combo")
                .await
                .text()
                .await
                .unwrap(),
            "quota-second"
        );

        // No combo write or route rebuild occurs between these two requests.
        assert_eq!(
            set_provider_quota(&client, &base, "quota-first", healthy()).await,
            200
        );
        assert_eq!(
            set_provider_quota(&client, &base, "quota-second", exhausted()).await,
            200
        );
        assert_eq!(
            chat_model(&client, &base, RUST_CLIENT_KEY, "quota-combo")
                .await
                .text()
                .await
                .unwrap(),
            "quota-first"
        );
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    assert_eq!(
        set_provider_quota(
            &client,
            &base,
            "quota-first",
            serde_json::json!({
                "weekly":{"remaining_percent":50.0,"reset_at_unix_ms":now + 86_400_000},
                "ttl_seconds":600
            })
        )
        .await,
        200
    );
    assert_eq!(
        set_provider_quota(
            &client,
            &base,
            "quota-second",
            serde_json::json!({
                "weekly":{"remaining_percent":50.0,"reset_at_unix_ms":now + 3_600_000},
                "ttl_seconds":600
            })
        )
        .await,
        200
    );
    assert_eq!(
        set_combo_strategy(&client, &base, "reset-window").await,
        200
    );
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "quota-combo")
            .await
            .text()
            .await
            .unwrap(),
        "quota-second"
    );

    let quotas = client
        .get(format!("{base}/api/admin/provider-quotas"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(quotas.status(), 200);
    let quotas: serde_json::Value = serde_json::from_str(&quotas.text().await.unwrap()).unwrap();
    assert_eq!(quotas["provider_quotas"].as_array().unwrap().len(), 2);
    assert_eq!(
        set_provider_quota(
            &client,
            &base,
            "quota-first",
            serde_json::json!({
                "weekly":{"remaining_percent":101.0},
                "ttl_seconds":600
            })
        )
        .await,
        400
    );
    assert_eq!(
        client
            .delete(format!("{base}/api/admin/provider-quotas/quota-second"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        204
    );

    gateway_task.abort();
    first_task.abort();
    second_task.abort();
    database.close().await.unwrap();
}

#[tokio::test]
async fn rust_control_plane_persists_provider_breaker_configuration_across_reset() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("breaker-config.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (provider_url, provider_task) = provider("breaker-secret", "healthy").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/configured"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "provider":"openai",
                    "upstream_url":provider_url,
                    "api_key":"breaker-secret"
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let endpoint = format!("{base}/api/admin/provider-health/configured");
    assert_eq!(
        client
            .put(&endpoint)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "failure_threshold":5,
                    "degradation_threshold":2,
                    "reset_timeout_ms":45_000
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .put(&endpoint)
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "failure_threshold":1,
                    "degradation_threshold":2,
                    "reset_timeout_ms":45_000
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    let configured = client
        .put(&endpoint)
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "failure_threshold":5,
                "degradation_threshold":2,
                "reset_timeout_ms":45_000
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(configured.status(), 200);
    let configured: serde_json::Value =
        serde_json::from_str(&configured.text().await.unwrap()).unwrap();
    assert_eq!(configured["provider_health"]["failure_threshold"], 5);
    assert_eq!(configured["provider_health"]["degradation_threshold"], 2);
    assert_eq!(configured["provider_health"]["reset_timeout_ms"], 45_000);

    gateway_task.abort();
    let restarted = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    let restarted_endpoint = format!("{restarted_base}/api/admin/provider-health/configured");
    let persisted = client
        .get(format!("{restarted_base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let persisted: serde_json::Value = serde_json::from_str(&persisted).unwrap();
    let persisted = persisted["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "configured")
        .unwrap();
    assert_eq!(persisted["failure_threshold"], 5);
    assert_eq!(persisted["degradation_threshold"], 2);
    assert_eq!(persisted["reset_timeout_ms"], 45_000);
    assert_eq!(
        client
            .delete(&restarted_endpoint)
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        204
    );

    restarted_task.abort();
    let reset = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (reset_base, reset_task) = gateway(reset).await;
    let reset = client
        .get(format!("{reset_base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let reset: serde_json::Value = serde_json::from_str(&reset).unwrap();
    let reset = reset["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "configured")
        .unwrap();
    assert_eq!(reset["state"], "closed");
    assert_eq!(reset["failure_threshold"], 5);
    assert_eq!(reset["degradation_threshold"], 2);
    assert_eq!(reset["reset_timeout_ms"], 45_000);

    reset_task.abort();
    provider_task.abort();
    database.close().await.unwrap();
}
