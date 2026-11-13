use axum::{
    body::{Body, Bytes},
    extract::Path,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use red_routerd::{
    control_plane::ControlPlane,
    router,
    storage::{Backend, Database, StoredResilience},
    ProxyState,
};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Write},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;
use url::Url;

const ADMIN_KEY: &str = "fixture-admin-key-1234567890-abcdef";
const CLIENT_KEY: &str = "fixture-client-key-1234567890";
const RUST_CLIENT_KEY: &str = "rust-owned-client-key-1234567890";
const STORAGE_KEY: &str = "fixture-storage-key-1234567890";

fn auth_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, content) in entries {
        writer.start_file(*name, options).unwrap();
        writer.write_all(content).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
const OIDC_PRIVATE_KEY: &str = r#"-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgWTFfCGljY6aw3Hrt
kHmPRiazukxPLb6ilpRAewjW8nihRANCAATDskChT+Altkm9X7MI69T3IUmrQU0L
950IxEzvw/x5BMEINRMrXLBJhqzO9Bm+d6JbqA21YQmd1Kt4RzLJR1W+
-----END PRIVATE KEY-----"#;

fn unverified_jwt(payload: serde_json::Value) -> String {
    format!(
        "{}.{}.fixture-signature",
        URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
    )
}

fn oidc_token(kid: &str, audience: &str, role: &str) -> String {
    oidc_token_for(kid, audience, role, "operator-123", "operator@example.com")
}

fn oidc_token_for(kid: &str, audience: &str, role: &str, subject: &str, email: &str) -> String {
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(kid.to_owned());
    encode(
        &header,
        &serde_json::json!({
            "iss":"https://issuer.example",
            "aud":audience,
            "sub":subject,
            "email":email,
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

async fn oidc_discovery_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let issuer = format!("http://{address}");
    let document_issuer = issuer.clone();
    let endpoint_base = issuer.clone();
    let mismatch_base = issuer.clone();
    let app = Router::new()
        .route(
            "/.well-known/openid-configuration",
            get(move || {
                let issuer = document_issuer.clone();
                let endpoint_base = endpoint_base.clone();
                async move {
                    Json(serde_json::json!({
                        "issuer":issuer,
                        "authorization_endpoint":format!("{endpoint_base}/authorize"),
                        "token_endpoint":format!("{endpoint_base}/token"),
                        "jwks_uri":format!("{endpoint_base}/jwks"),
                        "scopes_supported":["openid","profile","email","groups"],
                        "response_types_supported":["code"]
                    }))
                }
            }),
        )
        .route(
            "/mismatch/.well-known/openid-configuration",
            get(move || {
                let endpoint_base = mismatch_base.clone();
                async move {
                    Json(serde_json::json!({
                        "issuer":format!("{endpoint_base}/different"),
                        "authorization_endpoint":format!("{endpoint_base}/authorize"),
                        "token_endpoint":format!("{endpoint_base}/token"),
                        "jwks_uri":format!("{endpoint_base}/jwks"),
                        "scopes_supported":["openid"]
                    }))
                }
            }),
        );
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (issuer, task)
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

async fn captured_provider(
    expected_key: &'static str,
    label: &'static str,
) -> (
    String,
    Arc<Mutex<Vec<serde_json::Value>>>,
    tokio::task::JoinHandle<()>,
) {
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let observed = bodies.clone();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(
            move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                let observed = observed.clone();
                async move {
                    assert_eq!(
                        headers["authorization"].to_str().unwrap(),
                        format!("Bearer {expected_key}")
                    );
                    let is_summary = body
                        .pointer("/messages/0/content")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|content| content.contains("context summarizer"));
                    observed.lock().unwrap().push(body);
                    if is_summary {
                        Json(serde_json::json!({
                            "choices":[{"message":{"content":serde_json::json!({
                                "summary":"The user is migrating the Red Router backend from Next.js to Rust.",
                                "keyDecisions":["Rust owns proxy persistence"],
                                "taskProgress":"Context relay persistence is complete and provider handoff is being validated.",
                                "activeEntities":["red-routerd","context-relay"]
                            }).to_string()}}],
                            "usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}
                        }))
                        .into_response()
                    } else {
                        label.into_response()
                    }
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        format!("http://{address}/v1/chat/completions"),
        bodies,
        task,
    )
}

async fn usage_provider(
    expected_key: &'static str,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(
            move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                let observed = observed.clone();
                async move {
                    assert_eq!(
                        headers["authorization"].to_str().unwrap(),
                        format!("Bearer {expected_key}")
                    );
                    observed.fetch_add(1, Ordering::SeqCst);
                    if body.get("stream").and_then(serde_json::Value::as_bool) == Some(true) {
                        let frames = concat!(
                            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
                            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n",
                            "data: [DONE]\n\n"
                        );
                        axum::http::Response::builder()
                            .status(StatusCode::OK)
                            .header(header::CONTENT_TYPE, "text/event-stream")
                            .body(Body::from(frames))
                            .unwrap()
                    } else {
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "id":"usage-fixture",
                                "choices":[],
                                "usage":{"prompt_tokens":3,"completion_tokens":2}
                            })),
                        )
                            .into_response()
                    }
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        format!("http://{address}/v1/chat/completions"),
        requests,
        task,
    )
}

async fn fusion_provider(
    expected_key: &'static str,
    panel_text: &'static str,
    delay: Duration,
    release: Option<Arc<tokio::sync::Notify>>,
) -> (
    String,
    Arc<Mutex<Vec<serde_json::Value>>>,
    tokio::task::JoinHandle<()>,
) {
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let observed = bodies.clone();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(
            move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                let observed = observed.clone();
                let release = release.clone();
                async move {
                    assert_eq!(
                        headers["authorization"].to_str().unwrap(),
                        format!("Bearer {expected_key}")
                    );
                    let is_judge = body
                        .get("messages")
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|messages| {
                            messages.iter().any(|message| {
                                message
                                    .get("content")
                                    .and_then(serde_json::Value::as_str)
                                    .is_some_and(|content| {
                                        content.contains("=== PANEL RESPONSES ===")
                                    })
                            })
                        });
                    let streaming = is_judge
                        && body.get("stream").and_then(serde_json::Value::as_bool) == Some(true);
                    observed.lock().unwrap().push(body);
                    tokio::time::sleep(delay).await;
                    if let Some(release) = release {
                        release.notified().await;
                    }
                    let (content, prompt_tokens, completion_tokens) = if is_judge {
                        ("fused-answer", 9, 4)
                    } else {
                        (panel_text, 3, 2)
                    };
                    let response = serde_json::json!({
                        "id":"fusion-fixture",
                        "choices":[{"message":{"role":"assistant","content":content}}],
                        "usage":{
                            "prompt_tokens":prompt_tokens,
                            "completion_tokens":completion_tokens,
                            "total_tokens":prompt_tokens + completion_tokens
                        }
                    });
                    if streaming {
                        let frames = format!(
                            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                            serde_json::json!({
                                "choices":[{"delta":{"content":content}}]
                            }),
                            serde_json::json!({
                                "choices":[],
                                "usage":response["usage"]
                            })
                        );
                        axum::http::Response::builder()
                            .status(StatusCode::OK)
                            .header(header::CONTENT_TYPE, "text/event-stream")
                            .body(Body::from(frames))
                            .unwrap()
                    } else {
                        Json(response).into_response()
                    }
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        format!("http://{address}/v1/chat/completions"),
        bodies,
        task,
    )
}

async fn pipeline_provider(
    expected_key: &'static str,
    response_text: &'static str,
    transient_first: bool,
) -> (
    String,
    Arc<Mutex<Vec<serde_json::Value>>>,
    tokio::task::JoinHandle<()>,
) {
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let observed = bodies.clone();
    let requests = Arc::new(AtomicUsize::new(0));
    let request_count = requests.clone();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(
            move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                let observed = observed.clone();
                let request_count = request_count.clone();
                async move {
                    assert_eq!(
                        headers["authorization"].to_str().unwrap(),
                        format!("Bearer {expected_key}")
                    );
                    observed.lock().unwrap().push(body.clone());
                    let request = request_count.fetch_add(1, Ordering::SeqCst);
                    if transient_first && request == 0 {
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            Json(serde_json::json!({"error":{"message":"retry me"}})),
                        )
                            .into_response();
                    }
                    let usage = serde_json::json!({
                        "prompt_tokens":3,
                        "completion_tokens":2,
                        "total_tokens":5
                    });
                    if body.get("stream").and_then(serde_json::Value::as_bool) == Some(true) {
                        let frames = format!(
                            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                            serde_json::json!({
                                "choices":[{"delta":{"content":response_text}}]
                            }),
                            serde_json::json!({"choices":[],"usage":usage})
                        );
                        axum::http::Response::builder()
                            .status(StatusCode::OK)
                            .header(header::CONTENT_TYPE, "text/event-stream")
                            .body(Body::from(frames))
                            .unwrap()
                    } else {
                        Json(serde_json::json!({
                            "id":"pipeline-fixture",
                            "choices":[{
                                "message":{"role":"assistant","content":response_text}
                            }],
                            "usage":usage
                        }))
                        .into_response()
                    }
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        format!("http://{address}/v1/chat/completions"),
        bodies,
        task,
    )
}

async fn models_dev_catalog_server() -> (
    String,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let requests = Arc::new(AtomicUsize::new(0));
    let mode = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let current_mode = mode.clone();
    let app = Router::new().route(
        "/catalog.json",
        get(move |headers: HeaderMap| {
            let observed = observed.clone();
            let current_mode = current_mode.clone();
            async move {
                observed.fetch_add(1, Ordering::SeqCst);
                if current_mode.load(Ordering::SeqCst) == 0
                    && headers
                        .get(header::IF_NONE_MATCH)
                        .and_then(|value| value.to_str().ok())
                        == Some("\"fixture-v1\"")
                {
                    return StatusCode::NOT_MODIFIED.into_response();
                }
                if current_mode.load(Ordering::SeqCst) == 1 {
                    return Json(serde_json::json!({"error":"invalid fixture"})).into_response();
                }
                let mut response = Json(serde_json::json!({
                    "providers":{
                        "fixture-provider":{
                            "id":"fixture-provider",
                            "name":"Fixture Provider",
                            "api":"https://must-not-be-imported.invalid",
                            "env":["MUST_NOT_BE_IMPORTED"],
                            "models":{
                                "fixture-model":{
                                    "id":"fixture-model",
                                    "name":"Fixture Model",
                                    "reasoning":true,
                                    "tool_call":true,
                                    "modalities":{"input":["text"],"output":["text"]},
                                    "limit":{"context":4242,"output":42},
                                    "cost":{"input":0.25,"output":0.5},
                                    "headers":{"authorization":"must-not-be-imported"}
                                }
                            }
                        }
                    },
                    "models":{
                        "fixture/fixture-model":{
                            "id":"fixture/fixture-model",
                            "name":"Fixture Canonical Model",
                            "reasoning":true,
                            "tool_call":true,
                            "modalities":{"input":["text"],"output":["text"]},
                            "limit":{"context":4242,"output":42}
                        }
                    }
                }))
                .into_response();
                response.headers_mut().insert(
                    header::ETAG,
                    header::HeaderValue::from_static("\"fixture-v1\""),
                );
                response
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        format!("http://{address}/catalog.json"),
        requests,
        mode,
        task,
    )
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

async fn counted_status_provider(
    expected_key: &'static str,
    initial_status: StatusCode,
    retry_after: Option<&'static str>,
) -> (
    String,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    Arc<tokio::sync::RwLock<String>>,
    tokio::task::JoinHandle<()>,
) {
    let requests = Arc::new(AtomicUsize::new(0));
    let status = Arc::new(AtomicUsize::new(initial_status.as_u16() as usize));
    let body = Arc::new(tokio::sync::RwLock::new("retry".to_owned()));
    let observed = requests.clone();
    let current_status = status.clone();
    let current_body = body.clone();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap| {
            let observed = observed.clone();
            let current_status = current_status.clone();
            let current_body = current_body.clone();
            async move {
                assert_eq!(
                    headers["authorization"].to_str().unwrap(),
                    format!("Bearer {expected_key}")
                );
                observed.fetch_add(1, Ordering::SeqCst);
                let status =
                    StatusCode::from_u16(current_status.load(Ordering::SeqCst) as u16).unwrap();
                let mut response = axum::http::Response::builder().status(status);
                if let Some(retry_after) = retry_after {
                    response = response.header(header::RETRY_AFTER, retry_after);
                }
                response
                    .body(Body::from(current_body.read().await.clone()))
                    .unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        format!("http://{address}/v1/chat/completions"),
        requests,
        status,
        body,
        task,
    )
}

async fn model_scoped_provider(
    expected_key: &'static str,
) -> (
    String,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    Arc<tokio::sync::RwLock<String>>,
    tokio::task::JoinHandle<()>,
) {
    let missing_requests = Arc::new(AtomicUsize::new(0));
    let missing_status = Arc::new(AtomicUsize::new(404));
    let missing_body = Arc::new(tokio::sync::RwLock::new("missing".to_owned()));
    let observed = missing_requests.clone();
    let status = missing_status.clone();
    let current_body = missing_body.clone();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(
            move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                let observed = observed.clone();
                let failure_body = current_body.clone();
                async move {
                    assert_eq!(
                        headers["authorization"].to_str().unwrap(),
                        format!("Bearer {expected_key}")
                    );
                    if body["model"] == "missing-model" {
                        observed.fetch_add(1, Ordering::SeqCst);
                        (
                            StatusCode::from_u16(status.load(Ordering::SeqCst) as u16).unwrap(),
                            failure_body.read().await.clone(),
                        )
                            .into_response()
                    } else {
                        (StatusCode::OK, "model-ok").into_response()
                    }
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        format!("http://{address}/v1/chat/completions"),
        missing_requests,
        missing_status,
        missing_body,
        task,
    )
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
            Json(serde_json::json!({
                "object":"list",
                "data":[{"object":"embedding","embedding":[0.1,0.2],"index":0}],
                "model":"text-embedding-3-small",
                "usage":{"prompt_tokens":4,"total_tokens":4}
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1/embeddings"), task)
}

async fn rerank_usage_provider(
    expected_key: &'static str,
) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/v2/rerank",
        post(
            move |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                assert_eq!(
                    headers["authorization"].to_str().unwrap(),
                    format!("Bearer {expected_key}")
                );
                assert_eq!(body["model"], "rerank-v3.5");
                Json(serde_json::json!({
                    "id":"rerank-fixture",
                    "results":[{"index":1,"relevance_score":0.9}],
                    "meta":{
                        "api_version":{"version":"2"},
                        "billed_units":{"search_units":3}
                    }
                }))
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v2/rerank"), task)
}

async fn responses_provider(expected_key: &'static str) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/v1/responses",
        post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
            assert_eq!(
                headers["authorization"].to_str().unwrap(),
                format!("Bearer {expected_key}")
            );
            let completed = serde_json::json!({
                "id":"resp_fixture",
                "object":"response",
                "model":"gpt-4.1",
                "output":[],
                "usage":{
                    "input_tokens":3,
                    "output_tokens":2,
                    "total_tokens":5,
                    "input_tokens_details":{"cached_tokens":1},
                    "output_tokens_details":{"reasoning_tokens":1}
                }
            });
            if body.get("stream").and_then(serde_json::Value::as_bool) == Some(true) {
                let created = serde_json::json!({
                    "type":"response.created",
                    "response":{"id":"resp_fixture","object":"response","status":"in_progress","usage":null},
                    "sequence_number":0
                });
                let terminal = serde_json::json!({
                    "type":"response.completed",
                    "response":completed,
                    "sequence_number":1
                });
                axum::http::Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .body(Body::from(format!(
                        "event: response.created\ndata: {created}\n\nevent: response.completed\ndata: {terminal}\n\n"
                    )))
                    .unwrap()
                    .into_response()
            } else {
                Json(completed).into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1/responses"), task)
}

async fn anthropic_usage_provider(
    expected_key: &'static str,
) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/v1/messages",
        post(move |headers: HeaderMap, body: String| async move {
            assert_eq!(headers["x-api-key"].to_str().unwrap(), expected_key);
            let body: serde_json::Value = serde_json::from_str(&body).unwrap();
            if body.get("stream").and_then(serde_json::Value::as_bool) == Some(true) {
                return (
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    concat!(
                        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_fixture\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-5\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":3,\"output_tokens\":0,\"cache_read_input_tokens\":1,\"cache_creation_input_tokens\":1}}}\n\n",
                        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n",
                        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":2}}\n\n",
                        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                    ),
                )
                    .into_response();
            }
            Json(serde_json::json!({
                "id":"msg_fixture",
                "type":"message",
                "role":"assistant",
                "model":"claude-sonnet-4-5",
                "content":[{"type":"text","text":"ok"}],
                "stop_reason":"end_turn",
                "usage":{
                    "input_tokens":3,
                    "output_tokens":2,
                    "cache_read_input_tokens":1,
                    "cache_creation_input_tokens":1
                }
            }))
            .into_response()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1/messages"), task)
}

async fn anthropic_bearer_provider(
    expected_key: &'static str,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let app = Router::new().route(
        "/v1/messages",
        post(move |headers: HeaderMap| {
            let observed = observed.clone();
            async move {
                assert_eq!(
                    headers[header::AUTHORIZATION].to_str().unwrap(),
                    format!("Bearer {expected_key}")
                );
                assert!(headers.get("x-api-key").is_none());
                observed.fetch_add(1, Ordering::SeqCst);
                Json(serde_json::json!({
                    "id":"msg_bearer_fixture",
                    "type":"message",
                    "role":"assistant",
                    "model":"claude-fixture",
                    "content":[{"type":"text","text":"ok"}],
                    "stop_reason":"end_turn",
                    "usage":{"input_tokens":1,"output_tokens":1}
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1/messages"), requests, task)
}

async fn recording_anthropic_bearer_provider(
) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let observed = requests.clone();
    let app = Router::new().route(
        "/v1/messages",
        post(move |headers: HeaderMap| {
            let observed = observed.clone();
            async move {
                observed
                    .lock()
                    .unwrap()
                    .push(headers[header::AUTHORIZATION].to_str().unwrap().to_owned());
                Json(serde_json::json!({
                    "id":"msg_oauth_rotation_fixture",
                    "type":"message",
                    "role":"assistant",
                    "model":"claude-oauth-fixture",
                    "content":[{"type":"text","text":"ok"}],
                    "stop_reason":"end_turn",
                    "usage":{"input_tokens":1,"output_tokens":1}
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1/messages"), requests, task)
}

async fn claude_oauth_refresh_server() -> (
    Url,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    Arc<Mutex<Vec<String>>>,
    tokio::task::JoinHandle<()>,
) {
    let requests = Arc::new(AtomicUsize::new(0));
    let mode = Arc::new(AtomicUsize::new(0));
    let refresh_tokens = Arc::new(Mutex::new(Vec::new()));
    let observed_requests = requests.clone();
    let observed_mode = mode.clone();
    let observed_tokens = refresh_tokens.clone();
    let app = Router::new()
        .route(
            "/bootstrap",
            get(|headers: HeaderMap| async move {
                let token = headers[header::AUTHORIZATION]
                    .to_str()
                    .unwrap()
                    .strip_prefix("Bearer claude-access-")
                    .unwrap();
                assert_eq!(headers["anthropic-version"].to_str().unwrap(), "2023-06-01");
                assert_eq!(
                    headers["anthropic-beta"].to_str().unwrap(),
                    "oauth-2025-04-20"
                );
                if token == "unverified" {
                    StatusCode::UNAUTHORIZED.into_response()
                } else {
                    let account = match token {
                        "one" => "123e4567-e89b-42d3-a456-426614174001",
                        "two" => "123e4567-e89b-42d3-a456-426614174002",
                        _ => "123e4567-e89b-42d3-a456-426614174003",
                    };
                    Json(serde_json::json!({
                        "account_uuid":account,
                        "account_email":format!("claude-{token}@example.com"),
                        "organization_uuid":"claude-organization-fixture"
                    }))
                    .into_response()
                }
            }),
        )
        .route(
            "/token",
            post(move |headers: HeaderMap, body: String| {
                let observed_requests = observed_requests.clone();
                let observed_mode = observed_mode.clone();
                let observed_tokens = observed_tokens.clone();
                async move {
                    observed_requests.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        headers[header::CONTENT_TYPE].to_str().unwrap(),
                        "application/x-www-form-urlencoded"
                    );
                    assert_eq!(
                        headers["anthropic-beta"].to_str().unwrap(),
                        "oauth-2025-04-20"
                    );
                    let fields: std::collections::HashMap<_, _> =
                        url::form_urlencoded::parse(body.as_bytes())
                            .into_owned()
                            .collect();
                    assert_eq!(
                        fields.get("grant_type").map(String::as_str),
                        Some("refresh_token")
                    );
                    assert_eq!(
                        fields.get("client_id").map(String::as_str),
                        Some("9d1c250a-e61b-44d9-88ed-5944d1962f5e")
                    );
                    observed_tokens
                        .lock()
                        .unwrap()
                        .push(fields["refresh_token"].clone());
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    if observed_mode.load(Ordering::SeqCst) == 0 {
                        Json(serde_json::json!({
                            "access_token":"server-refreshed-access-token",
                            "refresh_token":"server-refreshed-refresh-token",
                            "expires_in":3600
                        }))
                        .into_response()
                    } else {
                        (
                            StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({"error":"invalid_grant"})),
                        )
                            .into_response()
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        Url::parse(&format!("http://{address}/token")).unwrap(),
        requests,
        mode,
        refresh_tokens,
        task,
    )
}

async fn github_copilot_fixture() -> (
    Url,
    String,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let refreshes = Arc::new(AtomicUsize::new(0));
    let inference = Arc::new(AtomicUsize::new(0));
    let observed_refreshes = refreshes.clone();
    let observed_inference = inference.clone();
    let expires_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3_600;
    let app = Router::new()
        .route(
            "/copilot-token",
            get(move |headers: HeaderMap| {
                let observed_refreshes = observed_refreshes.clone();
                async move {
                    observed_refreshes.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        headers[header::AUTHORIZATION].to_str().unwrap(),
                        "Bearer github-long-lived-token"
                    );
                    assert_eq!(
                        headers[header::USER_AGENT].to_str().unwrap(),
                        "GithubCopilot/1.0"
                    );
                    assert_eq!(
                        headers["editor-version"].to_str().unwrap(),
                        "copilot/1.0.88"
                    );
                    assert_eq!(
                        headers["editor-plugin-version"].to_str().unwrap(),
                        "copilot/1.0.88"
                    );
                    Json(serde_json::json!({
                        "token":"github-short-lived-copilot-token",
                        "expires_at":expires_at
                    }))
                }
            }),
        )
        .route(
            "/chat/completions",
            post(move |headers: HeaderMap| {
                let observed_inference = observed_inference.clone();
                async move {
                    observed_inference.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        headers[header::AUTHORIZATION].to_str().unwrap(),
                        "Bearer github-short-lived-copilot-token"
                    );
                    assert_eq!(
                        headers["copilot-integration-id"].to_str().unwrap(),
                        "copilot-developer-cli"
                    );
                    assert_eq!(
                        headers["editor-version"].to_str().unwrap(),
                        "copilot/1.0.88"
                    );
                    assert_eq!(
                        headers["openai-intent"].to_str().unwrap(),
                        "conversation-agent"
                    );
                    assert_eq!(
                        headers["x-interaction-type"].to_str().unwrap(),
                        "conversation-user"
                    );
                    assert_eq!(
                        headers["copilot-harness-id"].to_str().unwrap(),
                        "copilot-sdk"
                    );
                    assert_eq!(
                        headers["x-github-api-version"].to_str().unwrap(),
                        "2026-08-01"
                    );
                    assert_eq!(headers["x-initiator"].to_str().unwrap(), "user");
                    let machine_id = headers["x-client-machine-id"].to_str().unwrap();
                    assert_eq!(machine_id.len(), 36);
                    Json(serde_json::json!({
                        "id":"github-copilot-fixture",
                        "object":"chat.completion",
                        "model":"gpt-5.4",
                        "choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],
                        "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
                    }))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        Url::parse(&format!("http://{address}/token")).unwrap(),
        format!("http://{address}/chat/completions"),
        refreshes,
        inference,
        task,
    )
}

async fn xai_oauth_fixture() -> (
    Url,
    String,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let refreshes = Arc::new(AtomicUsize::new(0));
    let inference = Arc::new(AtomicUsize::new(0));
    let observed_refreshes = refreshes.clone();
    let observed_inference = inference.clone();
    let app = Router::new()
        .route(
            "/xai-token",
            post(move |headers: HeaderMap, body: String| {
                let observed_refreshes = observed_refreshes.clone();
                async move {
                    observed_refreshes.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        headers[header::CONTENT_TYPE].to_str().unwrap(),
                        "application/x-www-form-urlencoded"
                    );
                    let form = url::form_urlencoded::parse(body.as_bytes())
                        .into_owned()
                        .collect::<std::collections::HashMap<_, _>>();
                    assert_eq!(form.get("grant_type").map(String::as_str), Some("refresh_token"));
                    assert_eq!(form.get("client_id").map(String::as_str), Some("test-xai-client"));
                    assert_eq!(
                        form.get("refresh_token").map(String::as_str),
                        Some("xai-refresh-token")
                    );
                    Json(serde_json::json!({
                        "access_token":"xai-rotated-access-token",
                        "refresh_token":"xai-rotated-refresh-token",
                        "expires_in":3600,
                        "token_type":"Bearer"
                    }))
                }
            }),
        )
        .route(
            "/chat/completions",
            post(move |headers: HeaderMap| {
                let observed_inference = observed_inference.clone();
                async move {
                    observed_inference.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        headers[header::AUTHORIZATION].to_str().unwrap(),
                        "Bearer xai-rotated-access-token"
                    );
                    Json(serde_json::json!({
                        "id":"xai-oauth-fixture",
                        "object":"chat.completion",
                        "model":"grok-4.3",
                        "choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],
                        "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
                    }))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        Url::parse(&format!("http://{address}/token")).unwrap(),
        format!("http://{address}/chat/completions"),
        refreshes,
        inference,
        task,
    )
}

async fn codex_quota_server() -> (
    Url,
    Arc<AtomicUsize>,
    Arc<Mutex<Vec<(String, String, String, String)>>>,
    tokio::task::JoinHandle<()>,
) {
    let requests = Arc::new(AtomicUsize::new(0));
    let observed_requests = requests.clone();
    let headers_seen = Arc::new(Mutex::new(Vec::new()));
    let observed_headers = headers_seen.clone();
    let app = Router::new().route(
        "/codex-usage",
        get(move |headers: HeaderMap| {
            let observed_requests = observed_requests.clone();
            let observed_headers = observed_headers.clone();
            async move {
                observed_requests.fetch_add(1, Ordering::SeqCst);
                observed_headers.lock().unwrap().push((
                    headers[header::AUTHORIZATION].to_str().unwrap().to_owned(),
                    headers["chatgpt-account-id"].to_str().unwrap().to_owned(),
                    headers[header::USER_AGENT].to_str().unwrap().to_owned(),
                    headers["originator"].to_str().unwrap().to_owned(),
                ));
                Json(serde_json::json!({
                    "rate_limit":{
                        "primary_window":{"used_percent":80,"reset_after_seconds":60},
                        "secondary_window":{"used_percent":40,"reset_at":2_000_000_000},
                        "limit_reached":false
                    }
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        Url::parse(&format!("http://{address}/token")).unwrap(),
        requests,
        headers_seen,
        task,
    )
}

async fn provider_browser_oauth_server() -> (
    Url,
    Url,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let codex_requests = Arc::new(AtomicUsize::new(0));
    let claude_requests = Arc::new(AtomicUsize::new(0));
    let agy_requests = Arc::new(AtomicUsize::new(0));
    let xai_requests = Arc::new(AtomicUsize::new(0));
    let openference_requests = Arc::new(AtomicUsize::new(0));
    let observed_codex = codex_requests.clone();
    let observed_claude = claude_requests.clone();
    let observed_agy = agy_requests.clone();
    let observed_xai = xai_requests.clone();
    let observed_openference = openference_requests.clone();
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3_600;
    let codex_id_token = unverified_jwt(serde_json::json!({
        "email":"browser-codex@example.com",
        "sub":"browser-codex-user",
        "exp":expiry,
        "https://api.openai.com/auth":{
            "chatgpt_account_id":"browser-codex-workspace",
            "chatgpt_user_id":"browser-codex-user"
        }
    }));
    let codex_access_token = unverified_jwt(serde_json::json!({"exp":expiry}));
    let xai_id_token = unverified_jwt(serde_json::json!({
        "email":"browser-xai@example.com",
        "sub":"browser-xai-user",
        "exp":expiry
    }));
    let openference_id_token = unverified_jwt(serde_json::json!({
        "email":"browser-openference@example.com",
        "sub":"browser-openference-user",
        "exp":expiry
    }));
    let app = Router::new()
        .route(
            "/codex-token",
            post(move |headers: HeaderMap, body: String| {
                let observed = observed_codex.clone();
                let observed_agy = observed_agy.clone();
                let id_token = codex_id_token.clone();
                let access_token = codex_access_token.clone();
                async move {
                    assert_eq!(
                        headers[header::CONTENT_TYPE].to_str().unwrap(),
                        "application/x-www-form-urlencoded"
                    );
                    let fields: std::collections::HashMap<_, _> =
                        url::form_urlencoded::parse(body.as_bytes())
                            .into_owned()
                            .collect();
                    assert_eq!(fields["grant_type"], "authorization_code");
                    if fields["code"] == "agy-browser-code" {
                        observed_agy.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(fields["redirect_uri"], "http://127.0.0.1:9876/callback");
                        assert_eq!(fields["client_id"], "test-antigravity-client");
                        assert_eq!(fields["client_secret"], "test-antigravity-secret");
                        assert!(!fields.contains_key("code_verifier"));
                        return Json(serde_json::json!({
                            "access_token":"agy-access-browser",
                            "refresh_token":"agy-browser-refresh",
                            "expires_in":3600,
                            "token_type":"Bearer",
                            "scope":"https://www.googleapis.com/auth/cloud-platform"
                        }));
                    }
                    observed.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(fields["code"], "codex-browser-code");
                    assert_eq!(
                        fields["redirect_uri"],
                        "http://localhost:1455/auth/callback"
                    );
                    assert_eq!(fields["code_verifier"].len(), 43);
                    Json(serde_json::json!({
                        "access_token":access_token,
                        "refresh_token":"codex-browser-refresh",
                        "id_token":id_token,
                        "expires_in":3600
                    }))
                }
            }),
        )
        .route(
            "/xai-token",
            post(move |headers: HeaderMap, body: String| {
                let observed = observed_xai.clone();
                let id_token = xai_id_token.clone();
                async move {
                    observed.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        headers[header::CONTENT_TYPE].to_str().unwrap(),
                        "application/x-www-form-urlencoded"
                    );
                    let fields = url::form_urlencoded::parse(body.as_bytes())
                        .into_owned()
                        .collect::<std::collections::HashMap<_, _>>();
                    assert_eq!(fields["grant_type"], "authorization_code");
                    assert_eq!(fields["client_id"], "test-xai-client");
                    assert_eq!(fields["code"], "xai-browser-code");
                    assert_eq!(fields["redirect_uri"], "http://127.0.0.1:56121/callback");
                    assert_eq!(fields["code_verifier"].len(), 43);
                    Json(serde_json::json!({
                        "access_token":"xai-browser-access",
                        "refresh_token":"xai-browser-refresh",
                        "id_token":id_token,
                        "expires_in":3600,
                        "token_type":"Bearer"
                    }))
                }
            }),
        )
        .route(
            "/openference-token",
            post(move |headers: HeaderMap, body: String| {
                let observed = observed_openference.clone();
                let id_token = openference_id_token.clone();
                async move {
                    observed.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        headers[header::CONTENT_TYPE].to_str().unwrap(),
                        "application/x-www-form-urlencoded"
                    );
                    let fields = url::form_urlencoded::parse(body.as_bytes())
                        .into_owned()
                        .collect::<std::collections::HashMap<_, _>>();
                    assert_eq!(fields["client_id"], "omniroute");
                    if fields["grant_type"] == "refresh_token" {
                        assert_eq!(
                            fields["refresh_token"],
                            "openference-browser-refresh"
                        );
                        Json(serde_json::json!({
                            "access_token":"openference-rotated-access",
                            "refresh_token":"openference-rotated-refresh",
                            "expires_in":3600,
                            "token_type":"Bearer"
                        }))
                    } else {
                        assert_eq!(fields["grant_type"], "authorization_code");
                        assert_eq!(fields["code"], "openference-browser-code");
                        assert_eq!(
                            fields["redirect_uri"],
                            "http://127.0.0.1:56123/callback"
                        );
                        assert_eq!(fields["code_verifier"].len(), 43);
                        Json(serde_json::json!({
                            "access_token":"openference-browser-access",
                            "refresh_token":"openference-browser-refresh",
                            "id_token":id_token,
                            "expires_in":3600,
                            "token_type":"Bearer"
                        }))
                    }
                }
            }),
        )
        .route(
            "/openference-userinfo",
            get(|headers: HeaderMap| async move {
                assert_eq!(
                    headers[header::AUTHORIZATION].to_str().unwrap(),
                    "Bearer openference-browser-access"
                );
                Json(serde_json::json!({
                    "sub":"browser-openference-user",
                    "email":"browser-openference@example.com"
                }))
            }),
        )
        .route(
            "/openference/chat/completions",
            post(|headers: HeaderMap| async move {
                assert_eq!(
                    headers[header::AUTHORIZATION].to_str().unwrap(),
                    "Bearer openference-rotated-access"
                );
                Json(serde_json::json!({
                    "id":"openference-fixture",
                    "object":"chat.completion",
                    "model":"Qwen3.8 27b",
                    "choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],
                    "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
                }))
            }),
        )
        .route(
            "/claude-token",
            post(
                move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                    let observed = observed_claude.clone();
                    async move {
                        observed.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(
                            headers["anthropic-beta"].to_str().unwrap(),
                            "oauth-2025-04-20"
                        );
                        assert_eq!(body["grant_type"], "authorization_code");
                        assert_eq!(body["code"], "claude-browser-code");
                        assert_eq!(
                            body["redirect_uri"],
                            "https://platform.claude.com/oauth/code/callback"
                        );
                        assert_eq!(body["code_verifier"].as_str().unwrap().len(), 43);
                        assert!(body["state"].as_str().unwrap().starts_with("rr:v1:"));
                        Json(serde_json::json!({
                            "access_token":"claude-access-browser",
                            "refresh_token":"claude-browser-refresh",
                            "expires_in":3600,
                            "scope":"user:inference user:profile",
                            "subscription_type":"pro",
                            "rate_limit_tier":"tier-2"
                        }))
                    }
                },
            ),
        )
        .route(
            "/bootstrap",
            get(|headers: HeaderMap| async move {
                assert_eq!(
                    headers[header::AUTHORIZATION].to_str().unwrap(),
                    "Bearer claude-access-browser"
                );
                Json(serde_json::json!({
                    "account_uuid":"123e4567-e89b-42d3-a456-426614174004",
                    "account_email":"browser-claude@example.com"
                }))
            }),
        )
        .route(
            "/userinfo",
            get(|headers: HeaderMap| async move {
                assert_eq!(
                    headers[header::AUTHORIZATION].to_str().unwrap(),
                    "Bearer agy-access-browser"
                );
                Json(serde_json::json!({"email":"browser-agy@example.com"}))
            }),
        )
        .route(
            "/load-code-assist",
            post(|headers: HeaderMap| async move {
                assert_eq!(
                    headers[header::AUTHORIZATION].to_str().unwrap(),
                    "Bearer agy-access-browser"
                );
                Json(serde_json::json!({
                    "cloudaicompanionProject":{"id":"browser-agy-project"}
                }))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        Url::parse(&format!("http://{address}/codex-token")).unwrap(),
        Url::parse(&format!("http://{address}/claude-token")).unwrap(),
        codex_requests,
        claude_requests,
        agy_requests,
        xai_requests,
        openference_requests,
        task,
    )
}

async fn gemini_usage_provider(
    expected_key: &'static str,
) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route(
        "/v1beta/models/{model_action}",
        post(
            move |Path(model_action): Path<String>, headers: HeaderMap| async move {
                assert_eq!(headers["x-goog-api-key"].to_str().unwrap(), expected_key);
                let response = serde_json::json!({
                    "candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]}}],
                    "usageMetadata":{
                        "promptTokenCount":2,
                        "candidatesTokenCount":2,
                        "thoughtsTokenCount":1,
                        "cachedContentTokenCount":1,
                        "totalTokenCount":5
                    },
                    "modelVersion":"gemini-2.5-flash"
                });
                match model_action.as_str() {
                    "gemini-2.5-flash:generateContent" => Json(response).into_response(),
                    "gemini-2.5-flash:streamGenerateContent" => {
                        let first = serde_json::json!({
                            "candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]}}],
                            "modelVersion":"gemini-2.5-flash"
                        });
                        let mut terminal = response;
                        terminal["candidates"][0]["finishReason"] = serde_json::json!("STOP");
                        (
                            [(header::CONTENT_TYPE, "text/event-stream")],
                            format!("data: {first}\n\ndata: {terminal}\n\n"),
                        )
                            .into_response()
                    }
                    _ => panic!("unexpected Gemini action"),
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1beta/models"), task)
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

async fn chat_model_with_body(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    body: serde_json::Value,
) -> reqwest::Response {
    client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(key)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn runtime_settings_are_authenticated_versioned_and_persisted() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("runtime-settings.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let endpoint = format!("{base}/api/admin/runtime-settings");

    assert_eq!(
        client.get(&endpoint).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let defaults: serde_json::Value = client
        .get(&endpoint)
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        defaults["runtime_settings"]["quota_preflight_enabled"],
        false
    );
    assert_eq!(
        defaults["runtime_settings"]["quota_preflight_threshold_percent"],
        2.0
    );
    assert_eq!(
        defaults["runtime_settings"]["oauth_connection_cooldown"],
        serde_json::json!({
            "base_cooldown_ms":5_000,
            "use_upstream_retry_hints":false,
            "max_backoff_steps":8
        })
    );
    assert_eq!(
        defaults["runtime_settings"]["apikey_connection_cooldown"],
        serde_json::json!({
            "base_cooldown_ms":3_000,
            "use_upstream_retry_hints":true,
            "max_backoff_steps":5
        })
    );
    assert_eq!(
        defaults["runtime_settings"]["oauth_provider_breaker"],
        serde_json::json!({
            "failure_threshold":8,
            "degradation_threshold":5,
            "reset_timeout_ms":60_000
        })
    );
    assert_eq!(
        defaults["runtime_settings"]["apikey_provider_breaker"],
        serde_json::json!({
            "failure_threshold":12,
            "degradation_threshold":7,
            "reset_timeout_ms":30_000
        })
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/global-breaker"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"openai",
                "upstream_url":"https://api.openai.com/v1/chat/completions",
                "api_key":"global-breaker-secret"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let default_health: serde_json::Value = client
        .get(format!("{base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let default_health = &default_health["provider_health"][0];
    assert_eq!(default_health["failure_threshold"], 12);
    assert_eq!(default_health["degradation_threshold"], 7);
    assert_eq!(default_health["reset_timeout_ms"], 30_000);

    assert_eq!(
        client
            .put(&endpoint)
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "quota_preflight_enabled":true,
                "quota_preflight_threshold_percent":101,
                "oauth_connection_cooldown":{
                    "base_cooldown_ms":5_000,
                    "use_upstream_retry_hints":false,
                    "max_backoff_steps":8
                },
                "apikey_connection_cooldown":{
                    "base_cooldown_ms":3_000,
                    "use_upstream_retry_hints":true,
                    "max_backoff_steps":5
                }
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .put(&endpoint)
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "quota_preflight_enabled":true,
                "quota_preflight_threshold_percent":2,
                "oauth_connection_cooldown":{
                    "base_cooldown_ms":5_000,
                    "use_upstream_retry_hints":false,
                    "max_backoff_steps":17
                },
                "apikey_connection_cooldown":{
                    "base_cooldown_ms":3_000,
                    "use_upstream_retry_hints":true,
                    "max_backoff_steps":5
                }
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let updated: serde_json::Value = client
        .put(&endpoint)
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "quota_preflight_enabled":true,
            "quota_preflight_threshold_percent":2.5,
            "oauth_connection_cooldown":{
                "base_cooldown_ms":7_000,
                "use_upstream_retry_hints":true,
                "max_backoff_steps":6
            },
            "apikey_connection_cooldown":{
                "base_cooldown_ms":2_000,
                "use_upstream_retry_hints":false,
                "max_backoff_steps":4
            },
            "oauth_provider_breaker":{
                "failure_threshold":9,
                "degradation_threshold":4,
                "reset_timeout_ms":75_000
            },
            "apikey_provider_breaker":{
                "failure_threshold":15,
                "degradation_threshold":6,
                "reset_timeout_ms":45_000
            }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(updated["runtime_settings"]["quota_preflight_enabled"], true);
    assert_eq!(
        updated["runtime_settings"]["quota_preflight_threshold_percent"],
        2.5
    );
    assert_eq!(
        updated["runtime_settings"]["oauth_connection_cooldown"]["base_cooldown_ms"],
        7_000
    );
    assert_eq!(
        updated["runtime_settings"]["apikey_connection_cooldown"]["use_upstream_retry_hints"],
        false
    );
    assert_eq!(
        updated["runtime_settings"]["oauth_provider_breaker"]["failure_threshold"],
        9
    );
    assert_eq!(
        updated["runtime_settings"]["apikey_provider_breaker"]["reset_timeout_ms"],
        45_000
    );
    let updated_health: serde_json::Value = client
        .get(format!("{base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let updated_health = &updated_health["provider_health"][0];
    assert_eq!(updated_health["failure_threshold"], 15);
    assert_eq!(updated_health["degradation_threshold"], 6);
    assert_eq!(updated_health["reset_timeout_ms"], 45_000);
    assert_ne!(updated["runtime_settings"]["revision"], "0");
    gateway_task.abort();

    let restarted = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    let persisted: serde_json::Value = client
        .get(format!("{restarted_base}/api/admin/runtime-settings"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(persisted["runtime_settings"], updated["runtime_settings"]);
    restarted_task.abort();
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
async fn rust_control_plane_serves_the_bundled_models_dev_catalog_lazily() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("catalog.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .get(format!("{base}/api/admin/model-catalog"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let index = client
        .get(format!("{base}/api/admin/model-catalog"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(index.status(), StatusCode::OK);
    let index: serde_json::Value = serde_json::from_str(&index.text().await.unwrap()).unwrap();
    assert_eq!(
        index["manifest"]["upstreamRepository"],
        "https://github.com/anomalyco/models.dev"
    );
    assert_eq!(index["snapshot"]["source"], "bundled");
    assert!(index["providers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|provider| provider["id"] == "openai" && provider["name"] == "OpenAI"));

    let provider = client
        .get(format!("{base}/api/admin/model-catalog/openai"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(provider.status(), StatusCode::OK);
    let provider: serde_json::Value =
        serde_json::from_str(&provider.text().await.unwrap()).unwrap();
    let model = provider["provider"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["id"] == "gpt-3.5-turbo")
        .unwrap();
    assert_eq!(model["limit"]["context"], 16_385);
    assert_eq!(model["cost"]["input"], 0.5);
    assert_eq!(model["cost"]["output"], 1.5);
    assert_eq!(model["tool_call"], false);

    let search_url = format!("{base}/api/admin/model-catalog/search/models");
    assert_eq!(
        client.get(&search_url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let response = client
        .get(&search_url)
        .query(&[("query", "gpt-3.5-turbo"), ("limit", "1")])
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let page: serde_json::Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(page["models"].as_array().unwrap().len(), 1);
    assert!(page["total"].as_u64().unwrap() >= 1);
    assert!(page["models"][0]["provider_id"].is_string());
    assert_eq!(page["content_sha256"], index["manifest"]["contentSha256"]);
    for (query, expected) in [
        ("limit=101".to_owned(), StatusCode::BAD_REQUEST),
        (format!("snapshot={}", "0".repeat(64)), StatusCode::CONFLICT),
    ] {
        assert_eq!(
            client
                .get(format!("{search_url}?{query}"))
                .bearer_auth(ADMIN_KEY)
                .send()
                .await
                .unwrap()
                .status(),
            expected
        );
    }

    assert_eq!(
        client
            .get(format!("{base}/api/admin/model-catalog/not-a-provider"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    gateway_task.abort();
}

#[tokio::test]
async fn rust_control_plane_atomically_refreshes_and_reloads_models_dev_snapshot() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("catalog-refresh.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let (source, requests, mode, source_task) = models_dev_catalog_server().await;
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new_with_model_catalog_source(
        database.clone(),
        ADMIN_KEY,
        STORAGE_KEY,
        true,
        &source,
    )
    .await
    .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let follower_database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let follower = ControlPlane::new_with_model_catalog_source_and_poll_interval(
        follower_database.clone(),
        ADMIN_KEY,
        STORAGE_KEY,
        true,
        &source,
        Duration::from_millis(10),
    )
    .await
    .unwrap();
    let (follower_base, follower_task) = gateway(follower).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .post(format!("{base}/api/admin/model-catalog/refresh"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let refreshed = client
        .post(format!("{base}/api/admin/model-catalog/refresh"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(refreshed.status(), StatusCode::OK);
    let refreshed: serde_json::Value =
        serde_json::from_str(&refreshed.text().await.unwrap()).unwrap();
    assert_eq!(refreshed["snapshot"]["changed"], true);
    assert_eq!(refreshed["snapshot"]["source"], "persisted");
    assert_eq!(refreshed["snapshot"]["manifest"]["providers"], 1);

    let provider = client
        .get(format!("{base}/api/admin/model-catalog/fixture-provider"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(provider.status(), StatusCode::OK);
    let provider: serde_json::Value =
        serde_json::from_str(&provider.text().await.unwrap()).unwrap();
    assert_eq!(provider["provider"]["models"][0]["limit"]["context"], 4242);
    let persisted = database.model_catalog_snapshot().await.unwrap().unwrap();
    assert!(!persisted.snapshot_json.contains("must-not-be-imported"));
    assert!(!persisted.snapshot_json.contains("MUST_NOT_BE_IMPORTED"));
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if client
                .get(format!(
                    "{follower_base}/api/admin/model-catalog/fixture-provider"
                ))
                .bearer_auth(ADMIN_KEY)
                .send()
                .await
                .unwrap()
                .status()
                == StatusCode::OK
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the follower did not publish the shared catalog revision");

    let unchanged = client
        .post(format!("{base}/api/admin/model-catalog/refresh"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(unchanged.status(), StatusCode::OK);
    let unchanged: serde_json::Value =
        serde_json::from_str(&unchanged.text().await.unwrap()).unwrap();
    assert_eq!(unchanged["snapshot"]["changed"], false);
    assert_eq!(requests.load(Ordering::SeqCst), 2);

    mode.store(1, Ordering::SeqCst);
    assert_eq!(
        client
            .post(format!("{base}/api/admin/model-catalog/refresh"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(
        client
            .get(format!("{base}/api/admin/model-catalog/fixture-provider"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let index = client
        .get(format!("{base}/api/admin/model-catalog"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    let index: serde_json::Value = serde_json::from_str(&index.text().await.unwrap()).unwrap();
    assert_eq!(index["snapshot"]["source"], "persisted");
    assert_eq!(index["snapshot"]["last_error"], "models.dev refresh failed");

    gateway_task.abort();
    let _ = gateway_task.await;
    follower_task.abort();
    let _ = follower_task.await;
    follower_database.close().await.unwrap();
    drop(follower_database);
    database.close().await.unwrap();
    drop(database);
    let reopened = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let restored = ControlPlane::new_with_model_catalog_source(
        reopened,
        ADMIN_KEY,
        STORAGE_KEY,
        true,
        &source,
    )
    .await
    .unwrap();
    let (restored_base, restored_task) = gateway(restored).await;
    let restored_provider = client
        .get(format!(
            "{restored_base}/api/admin/model-catalog/fixture-provider"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(restored_provider.status(), StatusCode::OK);
    let restored_provider: serde_json::Value =
        serde_json::from_str(&restored_provider.text().await.unwrap()).unwrap();
    assert_eq!(
        restored_provider["provider"]["models"][0]["limit"]["context"],
        4242
    );

    restored_task.abort();
    source_task.abort();
}

#[tokio::test]
async fn migrated_key_cannot_be_enabled_before_quota_state_is_adopted() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("migration-gate.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (base, task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let endpoint = format!("{base}/api/admin/client-keys/key-a");
    let response = client
        .put(&endpoint)
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({"label":"Key A", "api_key":RUST_CLIENT_KEY, "enabled":false}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let db = sqlx::SqlitePool::connect(&url).await.unwrap();
    sqlx::raw_sql("CREATE TABLE redrouter_legacy_key_migration (key_id TEXT PRIMARY KEY,source_is_active INTEGER,source_is_banned INTEGER,source_revoked_at TEXT); INSERT INTO redrouter_legacy_key_migration VALUES ('key-a',1,0,NULL);").execute(&db).await.unwrap();
    let enable = || {
        client
            .put(&endpoint)
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"label":"Key A", "enabled":true}))
    };
    assert_eq!(
        enable().send().await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    sqlx::raw_sql("INSERT INTO redrouter_legacy_quota_baselines VALUES ('key-a','red',0,0,0,0); UPDATE redrouter_control_client_keys SET max_rpm=5 WHERE id='key-a'; UPDATE redrouter_control_client_key_quotas SET max_tokens_per_minute=200,max_tokens_per_day=1000,max_monthly_microusd=100,reservation_tokens=50,reservation_microusd=10 WHERE key_id='key-a';").execute(&db).await.unwrap();
    assert_eq!(
        enable().send().await.unwrap().status(),
        StatusCode::BAD_REQUEST,
        "enabling must not erase adopted limits"
    );
    let enable_with_limits = || {
        client.put(&endpoint).bearer_auth(ADMIN_KEY).json(&serde_json::json!({"label":"Key A", "enabled":true, "max_requests_per_minute":5, "max_tokens_per_minute":200, "max_tokens_per_day":1000, "max_spend_per_month_usd":0.0001, "reservation_tokens":50, "reservation_spend_usd":0.00001}))
    };
    assert_eq!(
        enable_with_limits().send().await.unwrap().status(),
        StatusCode::OK
    );
    sqlx::query(
        "UPDATE redrouter_legacy_key_migration SET source_is_banned=1 WHERE key_id='key-a'",
    )
    .execute(&db)
    .await
    .unwrap();
    assert_eq!(
        enable_with_limits().send().await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    db.close().await;
    task.abort();
}

#[tokio::test]
async fn rust_control_plane_issues_hash_only_named_client_keys() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("issued-keys.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let replica = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (replica_base, replica_task) = gateway(replica).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .post(format!("{base}/api/admin/client-keys"))
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(r#"{"label":"RedDB Cloud / Acme production"}"#)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );

    let default_tenants = client
        .get(format!("{base}/api/admin/tenants"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(default_tenants.status(), StatusCode::OK);
    let default_tenants: serde_json::Value =
        serde_json::from_str(&default_tenants.text().await.unwrap()).unwrap();
    assert_eq!(default_tenants["tenants"][0]["id"], "red");

    let tenant = client
        .put(format!("{base}/api/admin/tenants/acme"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(r#"{"slug":"acme","name":"Acme Corporation"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(tenant.status(), StatusCode::OK);

    let issued = client
        .post(format!("{base}/api/admin/client-keys"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "label":"RedDB Cloud / Acme production",
                "tenant_id":"acme",
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["*"]
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(issued.status(), StatusCode::CREATED);
    assert_eq!(issued.headers()[header::CACHE_CONTROL], "no-store");
    let issued: serde_json::Value = serde_json::from_str(&issued.text().await.unwrap()).unwrap();
    let raw_key = issued["key"].as_str().unwrap().to_owned();
    let key_id = issued["client_key"]["id"].as_str().unwrap().to_owned();
    assert!(raw_key.starts_with("rrk_"));
    assert!(raw_key.len() >= 40);
    assert!(key_id.starts_with("key_"));
    assert_eq!(
        issued["client_key"]["label"],
        "RedDB Cloud / Acme production"
    );
    assert_eq!(issued["client_key"]["tenant_id"], "acme");
    assert_eq!(issued["client_key"]["created_by"], "bootstrap-admin");

    let stored = database.client_keys().await.unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].id, key_id);
    assert_eq!(stored[0].label, "RedDB Cloud / Acme production");
    assert_eq!(stored[0].tenant_id, "acme");
    assert_eq!(stored[0].created_by, "bootstrap-admin");
    assert_ne!(stored[0].key_hash, raw_key);
    assert!(!format!("{stored:?}").contains(&raw_key));

    let listed = client
        .get(format!("{base}/api/admin/client-keys"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    let listed = listed.text().await.unwrap();
    assert!(!listed.contains(&raw_key));
    assert!(listed.contains("RedDB Cloud / Acme production"));

    let identity = client
        .get(format!("{base}/v1/key"))
        .bearer_auth(&raw_key)
        .send()
        .await
        .unwrap();
    assert_eq!(identity.status(), StatusCode::OK);
    let identity: serde_json::Value =
        serde_json::from_str(&identity.text().await.unwrap()).unwrap();
    assert_eq!(identity["id"], key_id);
    assert_eq!(identity["name"], "RedDB Cloud / Acme production");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if client
                .get(format!("{replica_base}/v1/key"))
                .bearer_auth(&raw_key)
                .send()
                .await
                .unwrap()
                .status()
                == StatusCode::OK
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("replica did not publish the client key snapshot");

    let denied_schedule = serde_json::json!({
        "enabled":true,
        "from":"00:00",
        "until":"00:00",
        "days":[0,1,2,3,4,5,6],
        "tz":"UTC"
    });
    let scheduled = client
        .put(format!("{base}/api/admin/client-keys/{key_id}"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "label":"RedDB Cloud / Acme production",
            "tenant_id":"acme",
            "scopes":["inference:chat"],
            "allowed_endpoints":["chat"],
            "allowed_models":["*"],
            "access_schedule":denied_schedule
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(scheduled.status(), StatusCode::OK);
    let scheduled: serde_json::Value =
        serde_json::from_str(&scheduled.text().await.unwrap()).unwrap();
    assert_eq!(scheduled["client_key"]["access_schedule"]["tz"], "UTC");
    assert_eq!(
        client
            .get(format!("{base}/v1/key"))
            .bearer_auth(&raw_key)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/{key_id}"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"RedDB Cloud / Acme production",
                "tenant_id":"acme",
                "access_schedule":{
                    "enabled":true,
                    "from":"08:00",
                    "until":"18:00",
                    "days":[1,2,3,4,5],
                    "tz":"not/a-timezone"
                }
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .get(format!("{base}/v1/key"))
            .bearer_auth(&raw_key)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let cleared = client
        .put(format!("{base}/api/admin/client-keys/{key_id}"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "label":"RedDB Cloud / Acme production",
            "tenant_id":"acme",
            "scopes":["inference:chat"],
            "allowed_endpoints":["chat"],
            "allowed_models":["*"],
            "access_schedule":null
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::OK);
    let cleared: serde_json::Value = serde_json::from_str(&cleared.text().await.unwrap()).unwrap();
    assert!(cleared["client_key"]["access_schedule"].is_null());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let primary = client
                .get(format!("{base}/v1/key"))
                .bearer_auth(&raw_key)
                .send()
                .await
                .unwrap()
                .status();
            let replica = client
                .get(format!("{replica_base}/v1/key"))
                .bearer_auth(&raw_key)
                .send()
                .await
                .unwrap()
                .status();
            if primary == StatusCode::OK && replica == StatusCode::OK {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("client access schedule did not converge across replicas");

    let provision_body = serde_json::json!({
        "label":"RedDB Cloud / Acme database key",
        "api_key":"cloud-generated-key-1234567890",
        "tenant_id":"acme",
        "scopes":["inference:chat"]
    })
    .to_string();
    for _ in 0..2 {
        let provisioned = client
            .put(format!(
                "{base}/api/provision/client-keys/reddb-cloud-acme-production"
            ))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(provision_body.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(provisioned.status(), StatusCode::OK);
        let provisioned: serde_json::Value =
            serde_json::from_str(&provisioned.text().await.unwrap()).unwrap();
        assert_eq!(provisioned["client_key"]["tenant_id"], "acme");
        assert_eq!(
            provisioned["client_key"]["id"],
            "reddb-cloud-acme-production"
        );
    }
    assert_eq!(
        client
            .put(format!(
                "{base}/api/provision/client-keys/reddb-cloud-acme-production"
            ))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"attempted owner change",
                    "api_key":"cloud-generated-key-1234567890",
                    "tenant_id":"red"
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );

    gateway_task.abort();
    let restarted = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    assert_eq!(
        client
            .get(format!("{restarted_base}/v1/key"))
            .bearer_auth(&raw_key)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{restarted_base}/api/admin/tenants/acme"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(r#"{"slug":"acme","name":"Acme Corporation","enabled":false}"#)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .get(format!("{restarted_base}/v1/key"))
            .bearer_auth(&raw_key)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if client
                .get(format!("{replica_base}/v1/key"))
                .bearer_auth(&raw_key)
                .send()
                .await
                .unwrap()
                .status()
                == StatusCode::UNAUTHORIZED
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("replica did not retire the disabled tenant snapshot");
    restarted_task.abort();
    replica_task.abort();
}

#[tokio::test]
async fn rust_control_plane_enforces_native_token_and_spend_quotas_for_chat_and_streaming() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("native-quotas.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (upstream, requests, provider_task) = usage_provider("native-usage-secret").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/native-usage"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "provider":"openai",
                    "upstream_url":upstream,
                    "api_key":"native-usage-secret"
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for (id, key) in [
        ("native-non-stream", "native-non-stream-key-1234567890"),
        ("native-stream", "native-stream-key-1234567890"),
    ] {
        let response = client
            .put(format!("{base}/api/admin/client-keys/{id}"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":id,
                    "api_key":key,
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["gpt-3.5-turbo"],
                    "allowed_provider_ids":["native-usage"],
                    "max_tokens_per_minute":10,
                    "max_tokens_per_day":100,
                    "max_spend_per_month_usd":0.01,
                    "reservation_tokens":10,
                    "reservation_spend_usd":0.01
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let configured: serde_json::Value =
            serde_json::from_str(&response.text().await.unwrap()).unwrap();
        assert_eq!(configured["client_key"]["max_tokens_per_minute"], 10);
        assert_eq!(configured["client_key"]["max_spend_per_month_usd"], 0.01);
    }

    let ordinary = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("native-non-stream-key-1234567890")
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(serde_json::json!({"model":"gpt-3.5-turbo","messages":[]}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(ordinary.status(), StatusCode::OK);
    let ordinary: serde_json::Value =
        serde_json::from_str(&ordinary.text().await.unwrap()).unwrap();
    assert_eq!(ordinary["usage"]["prompt_tokens"], 3);
    assert_eq!(
        chat_model(
            &client,
            &base,
            "native-non-stream-key-1234567890",
            "gpt-3.5-turbo",
        )
        .await
        .status(),
        StatusCode::TOO_MANY_REQUESTS
    );

    let stream = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("native-stream-key-1234567890")
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "model":"gpt-3.5-turbo",
                "messages":[],
                "stream":true,
                "stream_options":{"include_usage":true}
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(stream.status(), StatusCode::OK);
    assert!(stream.text().await.unwrap().contains("data: [DONE]"));
    let blocked_stream = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("native-stream-key-1234567890")
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "model":"gpt-3.5-turbo",
                "messages":[],
                "stream":true,
                "stream_options":{"include_usage":true}
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(blocked_stream.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(requests.load(Ordering::SeqCst), 2);

    let audit = sqlx::SqlitePool::connect(&url).await.unwrap();
    let ledger: (i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), SUM(tokens_input + tokens_output + tokens_reasoning), SUM(amount_microusd) FROM redrouter_usage_ledger",
    )
    .fetch_one(&audit)
    .await
    .unwrap();
    assert_eq!(ledger, (2, 10, 10));
    let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_usage_reservations")
        .fetch_one(&audit)
        .await
        .unwrap();
    assert_eq!(pending, 0);
    let report = client
        .get(format!("{base}/api/admin/usage?limit=2"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(report.status(), StatusCode::OK);
    assert_eq!(
        report.headers()[header::CACHE_CONTROL],
        "no-store, max-age=0"
    );
    let report: serde_json::Value = serde_json::from_str(&report.text().await.unwrap()).unwrap();
    assert_eq!(report["usage"]["request_count"], 2);
    assert_eq!(report["usage"]["tokens_input"], 6);
    assert_eq!(report["usage"]["tokens_output"], 4);
    assert_eq!(report["usage"]["amount_microusd"], 10);
    assert_eq!(report["usage"]["pending_request_count"], 0);
    assert_eq!(report["usage"]["entries"].as_array().unwrap().len(), 2);
    let first_page = client
        .get(format!("{base}/api/admin/usage?limit=1"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(first_page.status(), StatusCode::OK);
    let first_page: serde_json::Value =
        serde_json::from_str(&first_page.text().await.unwrap()).unwrap();
    assert_eq!(first_page["usage"]["request_count"], 2);
    assert_eq!(first_page["usage"]["entries"].as_array().unwrap().len(), 1);
    let first_event = first_page["usage"]["entries"][0]["event_id"]
        .as_str()
        .unwrap();
    let cursor = first_page["usage"]["next_cursor"].as_str().unwrap();
    let second_page = client
        .get(format!("{base}/api/admin/usage?limit=1&cursor={cursor}"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(second_page.status(), StatusCode::OK);
    let second_page: serde_json::Value =
        serde_json::from_str(&second_page.text().await.unwrap()).unwrap();
    assert_eq!(second_page["usage"]["request_count"], 2);
    assert_ne!(
        second_page["usage"]["entries"][0]["event_id"].as_str(),
        Some(first_event)
    );
    assert!(second_page["usage"]["next_cursor"].is_null());
    let filtered = client
        .get(format!(
            "{base}/api/admin/usage?key_id=native-stream&limit=1"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(filtered.status(), StatusCode::OK);
    let filtered: serde_json::Value =
        serde_json::from_str(&filtered.text().await.unwrap()).unwrap();
    assert_eq!(filtered["usage"]["request_count"], 1);
    assert_eq!(filtered["usage"]["entries"][0]["key_id"], "native-stream");
    assert_eq!(
        client
            .get(format!("{base}/api/admin/usage?limit=201"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .get(format!("{base}/api/admin/usage?cursor=invalid"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .get(format!("{base}/api/admin/usage"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("INSERT INTO redrouter_usage_counters (key_id,minute_bucket,consumed_tokens,updated_at_unix_ms) VALUES ('stale',1,1,60000)")
        .execute(&audit)
        .await
        .unwrap();
    sqlx::query("INSERT INTO redrouter_request_rate_counters (key_id,window_seconds,bucket_index,consumed_requests,updated_at_unix_ms) VALUES ('stale',60,1,1,60000)")
        .execute(&audit)
        .await
        .unwrap();
    assert_eq!(
        client
            .post(format!("{base}/api/admin/usage/maintenance"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let maintenance = client
        .post(format!("{base}/api/admin/usage/maintenance"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(maintenance.status(), StatusCode::OK);
    assert_eq!(
        maintenance.headers()[header::CACHE_CONTROL],
        "no-store, max-age=0"
    );
    let maintenance: serde_json::Value =
        serde_json::from_str(&maintenance.text().await.unwrap()).unwrap();
    assert_eq!(maintenance["maintenance"]["usage_counters_deleted"], 1);
    assert_eq!(maintenance["maintenance"]["request_counters_deleted"], 1);
    assert_eq!(maintenance["maintenance"]["has_more"], false);
    let ledger_after_maintenance: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_usage_ledger")
            .fetch_one(&audit)
            .await
            .unwrap();
    assert_eq!(ledger_after_maintenance, 2);
    audit.close().await;
    gateway_task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn rust_models_lists_only_routable_models_allowed_for_the_client() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("models.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (visible_url, visible_task) = provider("models-visible-secret", "visible").await;
    let (hidden_url, hidden_task) = provider("models-hidden-secret", "hidden").await;
    let (embedding_url, embedding_task) = embeddings_provider("models-embedding-secret").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    for (id, upstream_url, api_key) in [
        ("models-visible", visible_url, "models-visible-secret"),
        ("models-hidden", hidden_url, "models-hidden-secret"),
        ("models-embedding", embedding_url, "models-embedding-secret"),
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
                    .to_string()
                )
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/models-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Models client",
                    "api_key":RUST_CLIENT_KEY,
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["*"],
                    "allowed_provider_ids":["models-visible","models-embedding"]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .get(format!("{base}/v1/key"))
            .bearer_auth(CLIENT_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    for path in ["/v1/key", "/api/v1/key"] {
        let response = client
            .get(format!("{base}{path}"))
            .header("x-api-key", RUST_CLIENT_KEY)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert!(response.headers()[header::VARY]
            .to_str()
            .unwrap()
            .contains("x-api-key"));
        let key: serde_json::Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
        assert_eq!(key["object"], "api_key");
        assert_eq!(key["id"], "models-client");
        assert_eq!(key["name"], "Models client");
        assert_eq!(key["role"], "standard");
        assert_eq!(key["id_format"], "prefixed");
        assert_eq!(key["persisted"], true);
        assert_eq!(key["compatibility"]["complete"], false);
    }
    for (id, protocol, provider_id, model) in [
        ("visible-combo", "openai", "models-visible", "gpt-4o"),
        ("provider-hidden", "openai", "models-hidden", "gpt-4o"),
        (
            "endpoint-hidden",
            "openai-embeddings",
            "models-embedding",
            "text-embedding-3-small",
        ),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/combos/{id}"))
                .bearer_auth(ADMIN_KEY)
                .header(header::CONTENT_TYPE.as_str(), "application/json")
                .body(
                    serde_json::json!({
                        "protocol":protocol,
                        "strategy":"priority",
                        "fallback":true,
                        "targets":[{"provider_id":provider_id,"model":model}]
                    })
                    .to_string()
                )
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }

    assert_eq!(
        client
            .get(format!("{base}/v1/models"))
            .bearer_auth("not-a-valid-client-key-123456")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let mut catalog_version = None;
    for path in ["/v1/models", "/api/v1/models"] {
        let response = client
            .get(format!("{base}{path}"))
            .bearer_auth(RUST_CLIENT_KEY)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .unwrap()
                .to_str()
                .unwrap(),
            "private, no-store"
        );
        let version = response
            .headers()
            .get("x-redrouter-catalog-version")
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            catalog_version.get_or_insert_with(|| version.clone()),
            &version
        );
        assert_eq!(version.len(), 16);
        assert!(version.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let body: serde_json::Value =
            serde_json::from_str(&response.text().await.unwrap()).unwrap();
        assert_eq!(body["object"], "list");
        let entries = body["data"].as_array().unwrap();
        assert_eq!(entries.len(), 1, "unexpected model list: {body}");
        let model = &entries[0];
        assert_eq!(model["id"], "visible-combo");
        assert_eq!(model["object"], "model");
        assert_eq!(model["owned_by"], "combo");
        assert_eq!(model["type"], "chat");
        assert!(model["created"].as_u64().is_some());
        assert!(model["context_length"].as_u64().is_some());
        assert!(model["max_input_tokens"].as_u64().is_some());
        assert!(model["capabilities"]["tool_calling"].is_boolean());
        let mut versioned_entries = entries.clone();
        for entry in &mut versioned_entries {
            entry.as_object_mut().unwrap().remove("created");
        }
        let expected = hex::encode(Sha256::digest(
            serde_json::to_vec(&versioned_entries).unwrap(),
        ));
        assert_eq!(version, expected[..16]);
    }

    for path in ["/v1/models/visible-combo", "/api/v1/models/VISIBLE-COMBO"] {
        let response = client
            .get(format!("{base}{path}"))
            .bearer_auth(RUST_CLIENT_KEY)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["x-redrouter-catalog-version"]
                .to_str()
                .unwrap(),
            catalog_version.as_deref().unwrap()
        );
        let model: serde_json::Value =
            serde_json::from_str(&response.text().await.unwrap()).unwrap();
        assert_eq!(model["id"], "visible-combo");
        assert_eq!(model["context_length"], 128_000);
    }

    let model_info = client
        .get(format!("{base}/v1/models/info?id=visible-combo&kind=llm"))
        .bearer_auth(RUST_CLIENT_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(model_info.status(), StatusCode::OK);
    assert_eq!(
        model_info.headers()["x-redrouter-catalog-version"]
            .to_str()
            .unwrap(),
        catalog_version.as_deref().unwrap()
    );
    let model_info: serde_json::Value =
        serde_json::from_str(&model_info.text().await.unwrap()).unwrap();
    assert_eq!(model_info["id"], "visible-combo");
    assert_eq!(model_info["kind"], "llm");
    assert_eq!(model_info["endpoint"], "/v1/chat/completions");
    assert_eq!(model_info["contextWindow"], 128_000);
    assert!(model_info["capabilities"]["tool_calling"].is_boolean());

    for path in [
        "/v1/models/provider-hidden",
        "/v1/models/info?id=provider-hidden",
    ] {
        assert_eq!(
            client
                .get(format!("{base}{path}"))
                .bearer_auth(RUST_CLIENT_KEY)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        client
            .get(format!(
                "{base}/v1/models/info?id=visible-combo&kind=embedding"
            ))
            .bearer_auth(RUST_CLIENT_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .get(format!("{base}/v1/models/info?id=visible-combo&extra=true"))
            .bearer_auth(RUST_CLIENT_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let systemone = client
        .get(format!("{base}/v1/models/systemone"))
        .bearer_auth(RUST_CLIENT_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(systemone.status(), StatusCode::OK);
    let systemone: serde_json::Value =
        serde_json::from_str(&systemone.text().await.unwrap()).unwrap();
    assert_eq!(systemone["object"], "list");
    assert_eq!(systemone["data"], serde_json::json!([]));

    let catalog = client
        .get(format!("{base}/v1/catalog?for=redcode&variants=expand"))
        .header("x-api-key", RUST_CLIENT_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(catalog.status(), StatusCode::OK);
    assert_eq!(
        catalog.headers()["x-redrouter-catalog-version"]
            .to_str()
            .unwrap(),
        catalog_version.as_deref().unwrap()
    );
    assert!(catalog.headers()[header::VARY]
        .to_str()
        .unwrap()
        .contains("x-api-key"));
    let catalog: serde_json::Value = serde_json::from_str(&catalog.text().await.unwrap()).unwrap();
    assert_eq!(
        catalog["version"],
        catalog_version.as_ref().unwrap().as_str()
    );
    assert_eq!(catalog["groups"], serde_json::json!([]));
    assert_eq!(catalog["combos"][0]["id"], "visible-combo");
    assert_eq!(catalog["compatibility"]["complete"], false);

    let capabilities = client
        .get(format!("{base}/api/v1/capabilities"))
        .header("x-goog-api-key", RUST_CLIENT_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(capabilities.status(), StatusCode::OK);
    assert_eq!(
        capabilities.headers()["x-redrouter-catalog-version"]
            .to_str()
            .unwrap(),
        catalog_version.as_deref().unwrap()
    );
    let capabilities: serde_json::Value =
        serde_json::from_str(&capabilities.text().await.unwrap()).unwrap();
    assert_eq!(capabilities["product"], "red-router");
    assert_eq!(capabilities["catalog"]["version"], catalog["version"]);
    assert_eq!(capabilities["catalog"]["key_id_format_applied"], false);
    assert_eq!(
        capabilities["served_model_header"],
        "X-RedRouter-Served-Model"
    );
    assert_eq!(capabilities["systemone"]["available"], false);
    assert!(capabilities["combos"]["strategies"]
        .as_array()
        .unwrap()
        .iter()
        .any(|strategy| strategy == "quota-weighted"));
    assert!(capabilities["combos"]["strategies"]
        .as_array()
        .unwrap()
        .iter()
        .any(|strategy| strategy == "context-relay"));

    assert_eq!(
        client
            .get(format!("{base}/v1/catalog?limit=1"))
            .bearer_auth(RUST_CLIENT_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .get(format!("{base}/v1/catalog"))
            .header(header::AUTHORIZATION.as_str(), "Basic invalid")
            .header("x-api-key", RUST_CLIENT_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );

    let served = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "model":"visible-combo",
                "messages":[{"role":"user","content":"hello"}]
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(served.status(), StatusCode::OK);
    assert_eq!(
        served.headers()["x-redrouter-served-model"],
        "openai/gpt-4o"
    );
    assert_eq!(served.text().await.unwrap(), "visible");

    let denied = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(r#"{"model":"provider-hidden","messages":[]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert!(!denied.headers().contains_key("x-redrouter-served-model"));

    gateway_task.abort();
    visible_task.abort();
    hidden_task.abort();
    embedding_task.abort();
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
    let (red_provider_url, red_provider_task) =
        provider("oidc-red-provider-secret", "oidc-red").await;
    let (acme_provider_url, acme_provider_task) =
        provider("oidc-acme-provider-secret", "oidc-acme").await;
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
                    "allowed_subjects":[
                        "operator@example.com",
                        "cloud@acme.example",
                        "manager@acme.example",
                        "first.identity@example.com",
                        "renamed.identity@example.com"
                    ]
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
        StatusCode::UNAUTHORIZED
    );

    assert_eq!(
        client
            .put(format!("{base}/api/admin/identity-bindings/operator-admin"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "subject":"oidc:operator@example.com",
                    "tenant_id":"red",
                    "role":"admin"
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

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

    let canonical_binding = client
        .put(format!(
            "{base}/api/admin/identity-bindings/stable-oidc-admin"
        ))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "oidc_issuer":"https://issuer.example",
                "oidc_subject":"stable-user-123",
                "tenant_id":"red",
                "role":"admin"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(canonical_binding.status(), StatusCode::OK);
    let canonical_binding: serde_json::Value =
        serde_json::from_str(&canonical_binding.text().await.unwrap()).unwrap();
    let canonical_subject = canonical_binding["identity_binding"]["subject"]
        .as_str()
        .unwrap();
    assert!(canonical_subject.starts_with("oidc:v1:"));
    assert!(!canonical_subject.contains("stable-user-123"));
    for email in ["first.identity@example.com", "renamed.identity@example.com"] {
        let token = oidc_token_for(
            "ec01",
            "red-router-admin",
            "operator",
            "stable-user-123",
            email,
        );
        assert_eq!(
            client
                .get(format!("{base}/api/admin/providers"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    let same_email_different_subject = oidc_token_for(
        "ec01",
        "red-router-admin",
        "operator",
        "different-user-456",
        "renamed.identity@example.com",
    );
    assert_eq!(
        client
            .get(format!("{base}/api/admin/providers"))
            .bearer_auth(same_email_different_subject)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .delete(format!(
                "{base}/api/admin/identity-bindings/stable-oidc-admin"
            ))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    let removed_identity = oidc_token_for(
        "ec01",
        "red-router-admin",
        "operator",
        "stable-user-123",
        "renamed.identity@example.com",
    );
    assert_eq!(
        client
            .get(format!("{base}/api/admin/providers"))
            .bearer_auth(removed_identity)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .delete(format!(
                "{base}/api/admin/identity-bindings/stable-oidc-admin"
            ))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/tenants/acme"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(r#"{"slug":"acme","name":"Acme"}"#)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/identity-bindings/acme-cloud"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "subject":"oidc:cloud@acme.example",
                    "tenant_id":"acme",
                    "role":"issuer"
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/identity-bindings/acme-manager"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "subject":"oidc:manager@acme.example",
                    "tenant_id":"acme",
                    "role":"tenant-admin"
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let cloud = oidc_token_for(
        "ec01",
        "red-router-admin",
        "operator",
        "cloud-service",
        "cloud@acme.example",
    );
    assert_eq!(
        client
            .get(format!("{base}/api/admin/providers"))
            .bearer_auth(&cloud)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );

    let manager = oidc_token_for(
        "ec01",
        "red-router-admin",
        "operator",
        "acme-manager",
        "manager@acme.example",
    );
    for path in ["/api/admin/tenants", "/api/admin/identity-bindings"] {
        assert_eq!(
            client
                .get(format!("{base}{path}"))
                .bearer_auth(&manager)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED,
            "tenant administrators must not enumerate global identity configuration"
        );
    }
    for (id, tenant_id, upstream_url, api_key, bearer) in [
        (
            "oidc-red-provider",
            Some("red"),
            red_provider_url.clone(),
            "oidc-red-provider-secret",
            ADMIN_KEY,
        ),
        (
            "oidc-acme-provider",
            None,
            acme_provider_url.clone(),
            "oidc-acme-provider-secret",
            manager.as_str(),
        ),
    ] {
        let mut body = serde_json::json!({
            "provider":"openai",
            "upstream_url":upstream_url,
            "api_key":api_key
        });
        if let Some(tenant_id) = tenant_id {
            body["tenant_id"] = serde_json::Value::String(tenant_id.to_owned());
        }
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(bearer)
                .header(header::CONTENT_TYPE.as_str(), "application/json")
                .body(body.to_string())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/manager-cannot-own-red"))
            .bearer_auth(&manager)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "tenant_id":"red",
                    "provider":"openai",
                    "upstream_url":acme_provider_url,
                    "api_key":"never-stored-provider-secret"
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let scoped_providers = client
        .get(format!("{base}/api/admin/providers"))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_providers.status(), StatusCode::OK);
    let scoped_providers: serde_json::Value =
        serde_json::from_str(&scoped_providers.text().await.unwrap()).unwrap();
    assert_eq!(scoped_providers["providers"].as_array().unwrap().len(), 1);
    assert_eq!(scoped_providers["providers"][0]["id"], "oidc-acme-provider");
    assert_eq!(scoped_providers["providers"][0]["tenant_id"], "acme");
    let scoped_provider_audit = client
        .get(format!(
            "{base}/api/compliance/audit-log?action=provider.create"
        ))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_provider_audit.status(), StatusCode::OK);
    assert_eq!(
        scoped_provider_audit
            .headers()
            .get("x-total-count")
            .unwrap()
            .to_str()
            .unwrap(),
        "1"
    );
    let scoped_provider_audit: serde_json::Value =
        serde_json::from_str(&scoped_provider_audit.text().await.unwrap()).unwrap();
    assert_eq!(scoped_provider_audit[0]["tenantId"], "acme");
    assert_eq!(scoped_provider_audit[0]["target"], "oidc-acme-provider");
    assert_eq!(
        scoped_provider_audit[0]["actor"],
        "oidc:manager@acme.example"
    );
    let provider_audit_details = scoped_provider_audit[0]["details"].to_string();
    assert!(!provider_audit_details.contains("oidc-acme-provider-secret"));
    assert!(!provider_audit_details.contains("credential_ciphertext"));
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/red-managed-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "tenant_id":"red",
                    "strategy":"lkgp",
                    "targets":[{
                        "provider_id":"oidc-red-provider",
                        "model":"gpt-4o"
                    }]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/acme-managed-combo"))
            .bearer_auth(&manager)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"lkgp",
                    "targets":[{
                        "provider_id":"oidc-acme-provider",
                        "model":"gpt-4o"
                    }]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let scoped_combo_audit = client
        .get(format!(
            "{base}/api/compliance/audit-log?action=combo.create"
        ))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_combo_audit.status(), StatusCode::OK);
    assert_eq!(
        scoped_combo_audit
            .headers()
            .get("x-total-count")
            .unwrap()
            .to_str()
            .unwrap(),
        "1"
    );
    let scoped_combo_audit: serde_json::Value =
        serde_json::from_str(&scoped_combo_audit.text().await.unwrap()).unwrap();
    assert_eq!(scoped_combo_audit[0]["tenantId"], "acme");
    assert_eq!(scoped_combo_audit[0]["target"], "acme-managed-combo");
    assert_eq!(scoped_combo_audit[0]["resourceType"], "combo");
    let issued = client
        .post(format!("{base}/api/admin/client-keys"))
        .bearer_auth(&manager)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(r#"{"label":"Acme managed key"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(issued.status(), StatusCode::CREATED);
    let issued: serde_json::Value = serde_json::from_str(&issued.text().await.unwrap()).unwrap();
    assert_eq!(issued["client_key"]["tenant_id"], "acme");
    assert_eq!(
        issued["client_key"]["created_by"],
        "oidc:manager@acme.example"
    );
    let acme_key_id = issued["client_key"]["id"].as_str().unwrap();
    let scoped_audit = client
        .get(format!(
            "{base}/api/compliance/audit-log?action=client_key.create"
        ))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_audit.status(), StatusCode::OK);
    assert_eq!(
        scoped_audit
            .headers()
            .get("x-total-count")
            .unwrap()
            .to_str()
            .unwrap(),
        "1"
    );
    let scoped_audit: serde_json::Value =
        serde_json::from_str(&scoped_audit.text().await.unwrap()).unwrap();
    assert_eq!(scoped_audit[0]["tenantId"], "acme");
    assert_eq!(scoped_audit[0]["target"], acme_key_id);
    assert_eq!(scoped_audit[0]["actor"], "oidc:manager@acme.example");
    assert_eq!(scoped_audit[0]["resourceType"], "client_key");
    assert!(!scoped_audit[0]["details"].to_string().contains("rrk_"));
    let global_identity_audit = client
        .get(format!(
            "{base}/api/admin/audit-log?action=identity_binding.delete"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(global_identity_audit.status(), StatusCode::OK);
    let global_identity_audit: serde_json::Value =
        serde_json::from_str(&global_identity_audit.text().await.unwrap()).unwrap();
    assert_eq!(global_identity_audit[0]["target"], "stable-oidc-admin");
    assert_eq!(global_identity_audit[0]["actor"], "bootstrap-admin");
    let usage_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let usage_db = sqlx::SqlitePool::connect(&url).await.unwrap();
    for (event_id, key_id, tenant_id, amount) in [
        ("usage-acme", acme_key_id, "acme", 11_i64),
        ("usage-red", "red-key", "red", 29_i64),
    ] {
        sqlx::query("INSERT INTO redrouter_usage_ledger (event_id,key_id,tenant_id,provider,model,tokens_input,tokens_output,tokens_cache_read,tokens_cache_creation,tokens_reasoning,amount_microusd,pricing_known,pricing_snapshot,created_at_unix_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(event_id)
            .bind(key_id)
            .bind(tenant_id)
            .bind("openai")
            .bind("gpt-4o")
            .bind(3_i64)
            .bind(2_i64)
            .bind(0_i64)
            .bind(0_i64)
            .bind(1_i64)
            .bind(amount)
            .bind(1_i64)
            .bind(r#"{"source":"fixture","input":1,"output":2}"#)
            .bind(usage_time)
            .execute(&usage_db)
            .await
            .unwrap();
    }
    sqlx::raw_sql("CREATE TABLE redrouter_legacy_request_cost_ledger (__legacy_rowid INTEGER,api_key_id TEXT,tenant_id TEXT,provider TEXT,model TEXT,timestamp TEXT,tokens_input INTEGER,tokens_output INTEGER,tokens_reasoning INTEGER,amount_usd REAL,pricing_known INTEGER,success INTEGER); INSERT INTO redrouter_legacy_request_cost_ledger VALUES (1,'acme-key','acme','openai','gpt','2026-01-01',1,2,0,0.00000031,1,1),(2,'red-key','red','openai','gpt','2026-01-01',1,2,0,0.25,1,1),(3,'unknown-key',NULL,'openai','gpt','2026-01-01',1,2,0,0.5,1,1);").execute(&usage_db).await.unwrap();
    usage_db.close().await;
    let legacy_usage = client
        .get(format!("{base}/api/admin/legacy-usage"))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(legacy_usage.status(), StatusCode::OK);
    let legacy_usage: serde_json::Value =
        serde_json::from_str(&legacy_usage.text().await.unwrap()).unwrap();
    assert_eq!(
        legacy_usage["legacy_usage"]["entries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        legacy_usage["legacy_usage"]["entries"][0]["tenant_id"],
        "acme"
    );
    assert_eq!(
        legacy_usage["legacy_usage"]["entries"][0]["amount_usd"],
        0.00000031
    );
    assert_eq!(
        client
            .get(format!("{base}/api/admin/legacy-usage?tenant_id=red"))
            .bearer_auth(&manager)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let global_legacy = client
        .get(format!("{base}/api/admin/legacy-usage"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    let global_legacy: serde_json::Value =
        serde_json::from_str(&global_legacy.text().await.unwrap()).unwrap();
    assert_eq!(
        global_legacy["legacy_usage"]["entries"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let scoped_usage = client
        .get(format!("{base}/api/admin/usage"))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_usage.status(), StatusCode::OK);
    let scoped_usage: serde_json::Value =
        serde_json::from_str(&scoped_usage.text().await.unwrap()).unwrap();
    assert_eq!(scoped_usage["usage"]["request_count"], 1);
    assert_eq!(scoped_usage["usage"]["amount_microusd"], 11);
    assert_eq!(scoped_usage["usage"]["entries"][0]["tenant_id"], "acme");
    assert_eq!(
        scoped_usage["usage"]["entries"][0]["pricing_snapshot"]["source"],
        "fixture"
    );
    assert_eq!(
        client
            .get(format!("{base}/api/admin/usage?tenant_id=red"))
            .bearer_auth(&manager)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let global_usage = client
        .get(format!("{base}/api/admin/usage"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(global_usage.status(), StatusCode::OK);
    let global_usage: serde_json::Value =
        serde_json::from_str(&global_usage.text().await.unwrap()).unwrap();
    assert_eq!(global_usage["usage"]["request_count"], 2);
    assert_eq!(global_usage["usage"]["amount_microusd"], 40);
    let tied_page = client
        .get(format!("{base}/api/admin/usage?limit=1"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    let tied_page: serde_json::Value =
        serde_json::from_str(&tied_page.text().await.unwrap()).unwrap();
    assert_eq!(tied_page["usage"]["entries"][0]["event_id"], "usage-red");
    let tied_cursor = tied_page["usage"]["next_cursor"].as_str().unwrap();
    let tied_page = client
        .get(format!(
            "{base}/api/admin/usage?limit=1&cursor={tied_cursor}"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    let tied_page: serde_json::Value =
        serde_json::from_str(&tied_page.text().await.unwrap()).unwrap();
    assert_eq!(tied_page["usage"]["entries"][0]["event_id"], "usage-acme");
    assert!(tied_page["usage"]["next_cursor"].is_null());
    assert_eq!(
        client
            .post(format!("{base}/api/admin/client-keys"))
            .bearer_auth(&manager)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(r#"{"label":"Forbidden Red key","tenant_id":"red"}"#)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let scoped_combos = client
        .get(format!("{base}/api/admin/combos"))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_combos.status(), StatusCode::OK);
    let scoped_combos: serde_json::Value =
        serde_json::from_str(&scoped_combos.text().await.unwrap()).unwrap();
    assert_eq!(scoped_combos["combos"].as_array().unwrap().len(), 1);
    assert_eq!(scoped_combos["combos"][0]["tenant_id"], "acme");
    let health = client
        .put(format!(
            "{base}/api/admin/provider-health/oidc-acme-provider"
        ))
        .bearer_auth(&manager)
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
    assert_eq!(health.status(), StatusCode::OK);
    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/provider-health/oidc-red-provider"
            ))
            .bearer_auth(&manager)
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
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let scoped_health = client
        .get(format!("{base}/api/admin/provider-health"))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_health.status(), StatusCode::OK);
    let scoped_health: serde_json::Value =
        serde_json::from_str(&scoped_health.text().await.unwrap()).unwrap();
    assert_eq!(
        scoped_health["provider_health"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        scoped_health["provider_health"][0]["provider_id"],
        "oidc-acme-provider"
    );
    let scoped_health_audit = client
        .get(format!(
            "{base}/api/admin/audit-log?action=provider_health.configure"
        ))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_health_audit.status(), StatusCode::OK);
    let scoped_health_audit: serde_json::Value =
        serde_json::from_str(&scoped_health_audit.text().await.unwrap()).unwrap();
    assert_eq!(scoped_health_audit.as_array().unwrap().len(), 1);
    assert_eq!(scoped_health_audit[0]["tenantId"], "acme");
    assert_eq!(scoped_health_audit[0]["target"], "oidc-acme-provider");
    assert_eq!(scoped_health_audit[0]["resourceType"], "provider_health");
    assert_eq!(
        client
            .delete(format!(
                "{base}/api/admin/provider-health/oidc-acme-provider"
            ))
            .bearer_auth(&manager)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    let scoped_health_reset_audit = client
        .get(format!(
            "{base}/api/admin/audit-log?action=provider_health.reset"
        ))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_health_reset_audit.status(), StatusCode::OK);
    let scoped_health_reset_audit: serde_json::Value =
        serde_json::from_str(&scoped_health_reset_audit.text().await.unwrap()).unwrap();
    assert_eq!(scoped_health_reset_audit.as_array().unwrap().len(), 1);
    assert_eq!(scoped_health_reset_audit[0]["target"], "oidc-acme-provider");
    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/provider-quotas/oidc-acme-provider"
            ))
            .bearer_auth(&manager)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(r#"{"session":{"remaining_percent":50.0},"ttl_seconds":600}"#)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/provider-quotas/oidc-red-provider"
            ))
            .bearer_auth(&manager)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(r#"{"session":{"remaining_percent":50.0},"ttl_seconds":600}"#)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let scoped_quotas = client
        .get(format!("{base}/api/admin/provider-quotas"))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_quotas.status(), StatusCode::OK);
    let scoped_quotas: serde_json::Value =
        serde_json::from_str(&scoped_quotas.text().await.unwrap()).unwrap();
    assert_eq!(
        scoped_quotas["provider_quotas"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        scoped_quotas["provider_quotas"][0]["provider_id"],
        "oidc-acme-provider"
    );
    let scoped_quota_audit = client
        .get(format!(
            "{base}/api/admin/audit-log?action=provider_quota.create"
        ))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_quota_audit.status(), StatusCode::OK);
    let scoped_quota_audit: serde_json::Value =
        serde_json::from_str(&scoped_quota_audit.text().await.unwrap()).unwrap();
    assert_eq!(scoped_quota_audit.as_array().unwrap().len(), 1);
    assert_eq!(scoped_quota_audit[0]["tenantId"], "acme");
    assert_eq!(scoped_quota_audit[0]["target"], "oidc-acme-provider");
    assert_eq!(scoped_quota_audit[0]["resourceType"], "provider_quota");
    assert_eq!(
        client
            .delete(format!("{base}/api/admin/combos/acme-managed-combo/lkgp"))
            .bearer_auth(&manager)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        client
            .delete(format!("{base}/api/admin/combos/red-managed-combo/lkgp"))
            .bearer_auth(&manager)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let scoped_pin_audit = client
        .get(format!(
            "{base}/api/admin/audit-log?action=combo.route_pin.clear"
        ))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_pin_audit.status(), StatusCode::OK);
    assert_eq!(
        scoped_pin_audit
            .headers()
            .get("x-total-count")
            .unwrap()
            .to_str()
            .unwrap(),
        "1"
    );
    let scoped_pin_audit: serde_json::Value =
        serde_json::from_str(&scoped_pin_audit.text().await.unwrap()).unwrap();
    assert_eq!(scoped_pin_audit[0]["target"], "acme-managed-combo");
    assert_eq!(scoped_pin_audit[0]["resourceType"], "route_pin");
    let scoped_keys = client
        .get(format!("{base}/api/admin/client-keys"))
        .bearer_auth(&manager)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_keys.status(), StatusCode::OK);
    let scoped_keys: serde_json::Value =
        serde_json::from_str(&scoped_keys.text().await.unwrap()).unwrap();
    assert_eq!(scoped_keys["client_keys"].as_array().unwrap().len(), 1);
    assert_eq!(scoped_keys["client_keys"][0]["tenant_id"], "acme");
    assert_eq!(
        client
            .get(format!("{base}/api/admin/tenants"))
            .bearer_auth(&manager)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let provisioned = client
        .put(format!("{base}/api/provision/client-keys/acme-database"))
        .bearer_auth(&cloud)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "label":"Acme database",
                "api_key":"acme-cloud-generated-key-1234567890",
                "tenant_id":"acme"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(provisioned.status(), StatusCode::OK);
    let provisioned: serde_json::Value =
        serde_json::from_str(&provisioned.text().await.unwrap()).unwrap();
    assert_eq!(
        provisioned["client_key"]["created_by"],
        "oidc:cloud@acme.example"
    );
    assert_eq!(
        client
            .put(format!("{base}/api/provision/client-keys/red-database"))
            .bearer_auth(&cloud)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Red database",
                    "api_key":"red-cloud-generated-key-1234567890",
                    "tenant_id":"red"
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    for denied in [
        oidc_token("ec01", "other-audience", "operator"),
        oidc_token("ec01", "red-router-admin", "viewer"),
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
    // The preceding management flows may take longer than the 30-second
    // unknown-kid refresh cooldown on CI. A fresh burst may trigger one fetch,
    // but must not trigger a fetch for each attacker-controlled key identifier.
    let before_unknown_keys = jwks_requests.load(Ordering::SeqCst);
    for kid in [
        "unknown-key-a",
        "unknown-key-b",
        "unknown-key-c",
        "unknown-key-d",
    ] {
        assert_eq!(
            client
                .get(format!("{base}/api/admin/providers"))
                .bearer_auth(oidc_token(kid, "red-router-admin", "operator"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert!(
        jwks_requests.load(Ordering::SeqCst) - before_unknown_keys <= 1,
        "unknown-key bursts must respect the JWKS refresh cooldown"
    );

    gateway_task.abort();
    let jwks_before_restart = jwks_requests.load(Ordering::SeqCst);
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
    assert_eq!(
        jwks_requests.load(Ordering::SeqCst),
        jwks_before_restart + 1
    );
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
    red_provider_task.abort();
    acme_provider_task.abort();
}

#[tokio::test]
async fn rust_control_plane_converges_oidc_enablement_and_revocation_across_replicas() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("oidc-replicas.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let leader_database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let follower_database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let leader = ControlPlane::new(leader_database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let follower = ControlPlane::new(follower_database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (leader_base, leader_task) = gateway(leader).await;
    let (follower_base, follower_task) = gateway(follower).await;
    let (jwks_uri, _, jwks_task) = oidc_jwks().await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .put(format!(
                "{leader_base}/api/admin/identity-bindings/replica-operator"
            ))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "subject":"oidc:operator@example.com",
                    "tenant_id":"red",
                    "role":"admin"
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{leader_base}/api/admin/oidc"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "enabled":true,
                    "issuer":"https://issuer.example",
                    "audience":"red-router-admin",
                    "jwks_uri":jwks_uri,
                    "required_claims":{"org_role":["operator"]},
                    "allowed_subjects":["operator@example.com"]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let valid = oidc_token("ec01", "red-router-admin", "operator");
    tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            if client
                .get(format!("{follower_base}/api/admin/providers"))
                .bearer_auth(&valid)
                .send()
                .await
                .unwrap()
                .status()
                == StatusCode::OK
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("the follower did not publish the OIDC policy");

    assert_eq!(
        client
            .delete(format!(
                "{leader_base}/api/admin/identity-bindings/replica-operator"
            ))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        client
            .get(format!("{follower_base}/api/admin/providers"))
            .bearer_auth(&valid)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .put(format!(
                "{leader_base}/api/admin/identity-bindings/replica-operator"
            ))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "subject":"oidc:operator@example.com",
                    "tenant_id":"red",
                    "role":"admin"
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .get(format!("{follower_base}/api/admin/providers"))
            .bearer_auth(&valid)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    assert_eq!(
        client
            .delete(format!("{leader_base}/api/admin/oidc"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            if client
                .get(format!("{follower_base}/api/admin/providers"))
                .bearer_auth(&valid)
                .send()
                .await
                .unwrap()
                .status()
                == StatusCode::UNAUTHORIZED
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("the follower did not revoke the deleted OIDC policy");

    leader_task.abort();
    follower_task.abort();
    jwks_task.abort();
}

#[tokio::test]
async fn rust_control_plane_exposes_safe_browser_bootstrap_and_oidc_discovery() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("oidc-discovery.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (issuer, discovery_task) = oidc_discovery_server().await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    let config = client
        .get(format!("{base}/api/auth/config"))
        .send()
        .await
        .unwrap();
    assert_eq!(config.status(), StatusCode::OK);
    assert_eq!(
        config.headers()[header::CACHE_CONTROL],
        "no-store, max-age=0"
    );
    let config: serde_json::Value = serde_json::from_str(&config.text().await.unwrap()).unwrap();
    assert_eq!(config["backend"], "rust");
    assert_eq!(config["control_plane_enabled"], true);
    assert_eq!(config["oidc_browser_login"], false);
    assert_eq!(config["password_login"], true);

    let local_login = format!("{base}/api/auth/local/login");
    assert_eq!(
        client
            .post(&local_login)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(serde_json::json!({"admin_key":ADMIN_KEY}).to_string())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        client
            .post(&local_login)
            .header(header::ORIGIN, &base)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({"admin_key":"wrong-admin-key-that-is-long-enough"}).to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let local_session = client
        .post(&local_login)
        .header(header::ORIGIN, &base)
        .header("sec-fetch-site", "same-origin")
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(serde_json::json!({"admin_key":ADMIN_KEY}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(local_session.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        local_session.headers()[header::CACHE_CONTROL],
        "no-store, max-age=0"
    );
    assert_eq!(
        local_session
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .count(),
        2
    );
    let local_session_cookie = response_cookie(&local_session, "redrouter_admin_session").unwrap();
    let local_csrf_cookie = response_cookie(&local_session, "redrouter_admin_csrf").unwrap();
    let local_csrf = local_csrf_cookie.split_once('=').unwrap().1.to_owned();
    let local_cookies = format!("{local_session_cookie}; {local_csrf_cookie}");
    assert_eq!(
        client
            .get(format!("{base}/api/admin/providers"))
            .header(header::COOKIE, &local_cookies)
            .header("x-red-router-csrf", &local_csrf)
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
            .header(header::COOKIE, &local_cookies)
            .header(header::ORIGIN, &base)
            .send()
            .await
            .unwrap(),
        client
            .get(format!("{base}/api/admin/providers"))
            .header(header::COOKIE, &local_cookies)
            .header("x-red-router-csrf", &local_csrf)
            .header(header::ORIGIN, "https://attacker.example")
            .send()
            .await
            .unwrap(),
    ] {
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    }

    let endpoint = format!("{base}/api/admin/oidc/discover");
    assert_eq!(
        client
            .post(&endpoint)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(serde_json::json!({"issuer":issuer}).to_string())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let discovered = client
        .post(endpoint)
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(serde_json::json!({"issuer":issuer}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(discovered.status(), StatusCode::OK);
    let discovered: serde_json::Value =
        serde_json::from_str(&discovered.text().await.unwrap()).unwrap();
    assert_eq!(discovered["discovery"]["issuer"], issuer);
    assert_eq!(
        discovered["discovery"]["scopes_supported"],
        serde_json::json!(["openid", "profile", "email", "groups"])
    );
    assert_eq!(
        discovered["discovery"]["authorization_endpoint"],
        format!("{issuer}/authorize")
    );
    assert_eq!(
        client
            .post(format!("{base}/api/admin/oidc/discover"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(serde_json::json!({"issuer":format!("{issuer}/mismatch")}).to_string())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );

    gateway_task.abort();
    discovery_task.abort();
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

    assert_eq!(
        client
            .put(format!("{base}/api/admin/identity-bindings/operator-admin"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "subject":"oidc:operator@example.com",
                    "tenant_id":"red",
                    "role":"admin"
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let public_config = client
        .get(format!("{base}/api/auth/config"))
        .send()
        .await
        .unwrap();
    assert_eq!(public_config.status(), StatusCode::OK);
    let public_config: serde_json::Value =
        serde_json::from_str(&public_config.text().await.unwrap()).unwrap();
    assert_eq!(public_config["oidc_browser_login"], true);

    let test_login = client
        .get(format!("{base}/api/auth/oidc/login?test=1"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(test_login.status(), StatusCode::TEMPORARY_REDIRECT);
    let test_flow_cookie = response_cookie(&test_login, "redrouter_oidc_flow").unwrap();
    let test_authorization =
        Url::parse(test_login.headers()[header::LOCATION].to_str().unwrap()).unwrap();
    let test_parameters: std::collections::HashMap<_, _> =
        test_authorization.query_pairs().into_owned().collect();
    *nonce.write().await = test_parameters.get("nonce").unwrap().clone();
    let test_callback = client
        .get(format!(
            "{base}/api/auth/oidc/callback?code=fixture-code&state={}",
            test_parameters.get("state").unwrap()
        ))
        .header(header::COOKIE, test_flow_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(test_callback.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        test_callback.headers()[header::LOCATION].to_str().unwrap(),
        format!("{base}/dashboard/settings?tab=security&oidc_test=ok")
    );

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
    assert_eq!(
        client
            .get(format!("{base}/api/admin/providers"))
            .header(header::COOKIE, &cookies)
            .header("x-red-router-csrf", &csrf)
            .header("sec-fetch-site", "same-origin")
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
        client
            .get(format!("{base}/api/admin/providers"))
            .header(header::COOKIE, &cookies)
            .header("x-red-router-csrf", &csrf)
            .header("sec-fetch-site", "cross-site")
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
    let pricing = sqlx::SqlitePool::connect(&url).await.unwrap();
    sqlx::query("INSERT INTO key_value(namespace,key,value) VALUES ('pricing','cohere',?)")
        .bind(r#"{"rerank-v3.5":{"search_unit_cost":0.002}}"#)
        .execute(&pricing)
        .await
        .unwrap();
    pricing.close().await;
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (provider_url, provider_task) = embeddings_provider("embedding-secret").await;
    let (rerank_url, rerank_task) = rerank_usage_provider("rerank-secret").await;
    let (responses_url, responses_task) = responses_provider("responses-secret").await;
    let (anthropic_url, anthropic_task) = anthropic_usage_provider("anthropic-usage-secret").await;
    let (gemini_url, gemini_task) = gemini_usage_provider("gemini-usage-secret").await;
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
    for (id, provider, upstream_url, api_key) in [
        (
            "anthropic-provider",
            "anthropic",
            anthropic_url,
            "anthropic-usage-secret",
        ),
        (
            "gemini-provider",
            "google",
            gemini_url,
            "gemini-usage-secret",
        ),
        ("rerank-provider", "cohere", rerank_url, "rerank-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .header(header::CONTENT_TYPE.as_str(), "application/json")
                .body(
                    serde_json::json!({
                        "provider":provider,
                        "upstream_url":upstream_url,
                        "api_key":api_key
                    })
                    .to_string()
                )
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/responses-provider"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "provider":"openai",
                    "upstream_url":responses_url,
                    "api_key":"responses-secret"
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
                    "scopes":["inference:embeddings","inference:rerank","inference:chat"],
                    "allowed_endpoints":["embeddings","rerank","chat"],
                    "allowed_models":["embedding-combo","text-embedding-3-small","responses-combo","gpt-4.1","anthropic-combo","claude-sonnet-4-5","gemini-combo","gemini-2.5-flash","rerank-combo","rerank-v3.5"],
                    "allowed_provider_ids":["embedding-provider","responses-provider","anthropic-provider","gemini-provider","rerank-provider"],
                    "max_tokens_per_minute":80,
                    "max_tokens_per_day":100,
                    "reservation_tokens":10
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
            .put(format!("{base}/api/admin/combos/responses-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "protocol":"openai-responses",
                    "strategy":"priority",
                    "targets":[{
                        "provider_id":"responses-provider",
                        "model":"gpt-4.1"
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
    for (id, protocol, provider_id, model) in [
        (
            "anthropic-combo",
            "anthropic",
            "anthropic-provider",
            "claude-sonnet-4-5",
        ),
        (
            "gemini-combo",
            "gemini",
            "gemini-provider",
            "gemini-2.5-flash",
        ),
        (
            "rerank-combo",
            "cohere-rerank",
            "rerank-provider",
            "rerank-v3.5",
        ),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/combos/{id}"))
                .bearer_auth(ADMIN_KEY)
                .header(header::CONTENT_TYPE.as_str(), "application/json")
                .body(
                    serde_json::json!({
                        "protocol":protocol,
                        "strategy":"priority",
                        "targets":[{"provider_id":provider_id,"model":model}]
                    })
                    .to_string()
                )
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
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
    let response: serde_json::Value =
        serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(response["usage"]["prompt_tokens"], 4);
    let streamed = client
        .post(format!("{base}/v1/responses"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "model":"responses-combo",
                "input":"hello",
                "stream":true
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(streamed.status(), StatusCode::OK);
    let streamed = streamed.text().await.unwrap();
    assert!(streamed.contains("event: response.created"));
    assert!(streamed.contains("event: response.completed"));
    let response = client
        .post(format!("{base}/v1/responses"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(serde_json::json!({"model":"responses-combo","input":"hello"}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response: serde_json::Value =
        serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(response["usage"]["input_tokens"], 3);
    assert_eq!(
        response["usage"]["output_tokens_details"]["reasoning_tokens"],
        1
    );
    let anthropic_stream = client
        .post(format!("{base}/v1/messages"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "model":"anthropic-combo",
                "messages":[],
                "max_tokens":16,
                "stream":true
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(anthropic_stream.status(), StatusCode::OK);
    let anthropic_stream = anthropic_stream.text().await.unwrap();
    assert!(anthropic_stream.contains("event: message_start"));
    assert!(anthropic_stream.contains("event: message_stop"));
    let anthropic = client
        .post(format!("{base}/v1/messages"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "model":"anthropic-combo",
                "messages":[],
                "max_tokens":16
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(anthropic.status(), StatusCode::OK);
    let anthropic: serde_json::Value =
        serde_json::from_str(&anthropic.text().await.unwrap()).unwrap();
    assert_eq!(anthropic["usage"]["cache_read_input_tokens"], 1);
    let gemini_stream = client
        .post(format!(
            "{base}/v1beta/models/gemini-combo:streamGenerateContent"
        ))
        .bearer_auth(RUST_CLIENT_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(r#"{"contents":[]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(gemini_stream.status(), StatusCode::OK);
    let gemini_stream = gemini_stream.text().await.unwrap();
    assert!(gemini_stream.contains("\"finishReason\":\"STOP\""));
    assert!(gemini_stream.contains("\"usageMetadata\""));
    let gemini = client
        .post(format!("{base}/v1beta/models/gemini-combo:generateContent"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(r#"{"contents":[]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(gemini.status(), StatusCode::OK);
    let gemini: serde_json::Value = serde_json::from_str(&gemini.text().await.unwrap()).unwrap();
    assert_eq!(gemini["usageMetadata"]["thoughtsTokenCount"], 1);
    let rerank = client
        .post(format!("{base}/v1/rerank"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "model":"rerank-combo",
                "query":"needle",
                "documents":["first","second"],
                "top_n":1
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(rerank.status(), StatusCode::OK);
    let rerank: serde_json::Value = serde_json::from_str(&rerank.text().await.unwrap()).unwrap();
    assert_eq!(rerank["meta"]["billed_units"]["search_units"], 3);
    let audit = sqlx::SqlitePool::connect(&url).await.unwrap();
    let ledger: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), SUM(tokens_input), SUM(tokens_output), SUM(tokens_reasoning) FROM redrouter_usage_ledger WHERE key_id='embedding-client'",
    )
    .fetch_one(&audit)
    .await
    .unwrap();
    assert_eq!(ledger, (8, 24, 14, 4));
    let rerank_ledger: (String, i64, i64, i64, String) = sqlx::query_as("SELECT usage_kind,search_units,tokens_input + tokens_output + tokens_reasoning,amount_microusd,pricing_snapshot FROM redrouter_usage_ledger WHERE key_id='embedding-client' AND usage_kind='rerank'")
        .fetch_one(&audit)
        .await
        .unwrap();
    assert_eq!(
        (
            rerank_ledger.0.as_str(),
            rerank_ledger.1,
            rerank_ledger.2,
            rerank_ledger.3
        ),
        ("rerank", 3, 0, 6_000)
    );
    let rerank_pricing: serde_json::Value = serde_json::from_str(&rerank_ledger.4).unwrap();
    assert_eq!(rerank_pricing["unit"], "search-unit");
    assert_eq!(rerank_pricing["source"], "dashboard-user");
    audit.close().await;
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "embedding-combo")
            .await
            .status(),
        404
    );

    gateway_task.abort();
    provider_task.abort();
    responses_task.abort();
    anthropic_task.abort();
    gemini_task.abort();
    rerank_task.abort();
}

#[tokio::test]
async fn fusion_fans_out_with_quorum_accounts_each_call_and_preserves_tool_calls() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("fusion.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (judge_url, judge_bodies, judge_task) = fusion_provider(
        "fusion-judge-secret",
        "alpha evidence",
        Duration::from_millis(15),
        None,
    )
    .await;
    let (second_url, second_bodies, second_task) = fusion_provider(
        "fusion-second-secret",
        "beta evidence",
        Duration::from_millis(25),
        None,
    )
    .await;
    let release_slow = Arc::new(tokio::sync::Notify::new());
    let (slow_url, slow_bodies, slow_task) = fusion_provider(
        "fusion-slow-secret",
        "late evidence",
        Duration::ZERO,
        Some(release_slow.clone()),
    )
    .await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let audit = sqlx::SqlitePool::connect(&url).await.unwrap();

    for (id, upstream_url, api_key) in [
        ("fusion-judge", judge_url, "fusion-judge-secret"),
        ("fusion-second", second_url, "fusion-second-secret"),
        ("fusion-slow", slow_url, "fusion-slow-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"openai-compatible",
                    "upstream_url":upstream_url,
                    "api_key":api_key
                }))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/fusion-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Fusion workload",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["fusion-combo","judge-model","second-model","slow-model"],
                "allowed_provider_ids":["fusion-judge","fusion-second","fusion-slow"],
                "max_tokens_per_minute":1000,
                "max_tokens_per_day":10000,
                "reservation_tokens":50
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let invalid_judge = client
        .put(format!("{base}/api/admin/combos/fusion-combo"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "strategy":"fusion",
            "fusion":{"judgeModel":"missing/model"},
            "targets":[
                {"provider_id":"fusion-judge","model":"judge-model"},
                {"provider_id":"fusion-second","model":"second-model"}
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_judge.status(), StatusCode::BAD_REQUEST);
    let configured = client
        .put(format!("{base}/api/admin/combos/fusion-combo"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "strategy":"fusion",
            "fallback":true,
            "fusion":{
                "judgeModel":" fusion-judge/judge-model ",
                "minPanel":2,
                "stragglerGraceMs":100,
                "panelTimeoutMs":30000
            },
            "targets":[
                {"provider_id":"fusion-judge","model":"judge-model"},
                {"provider_id":"fusion-second","model":"second-model"},
                {"provider_id":"fusion-slow","model":"slow-model"}
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(configured.status(), StatusCode::OK);
    let configured: serde_json::Value = configured.json().await.unwrap();
    assert_eq!(
        configured["combo"]["fusion"]["judgeModel"],
        "fusion-judge/judge-model"
    );
    assert_eq!(configured["combo"]["fusion"]["minPanel"], 2);

    let response = tokio::time::timeout(Duration::from_secs(10), async {
        let response = chat_model_with_body(
            &client,
            &base,
            RUST_CLIENT_KEY,
            serde_json::json!({
                "model":"fusion-combo",
                "messages":[{"role":"user","content":"compare the options"}],
                "stream":true,
                "stream_options":{"include_usage":true}
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        response.text().await.unwrap()
    })
    .await
    .expect("fusion waited for the blocked straggler instead of honoring quorum grace");
    assert!(response.contains("fused-answer"));
    assert!(response.contains("data: [DONE]"));

    {
        let bodies = judge_bodies.lock().unwrap();
        assert_eq!(bodies.len(), 2);
        let panel = bodies
            .iter()
            .find(|body| body["messages"].as_array().unwrap().len() == 1)
            .unwrap();
        assert_eq!(panel["stream"], false);
        assert!(panel.get("tools").is_none());
        assert!(panel.get("stream_options").is_none());
        let judge = bodies
            .iter()
            .find(|body| body["messages"].as_array().unwrap().len() == 2)
            .unwrap();
        let prompt = judge["messages"][1]["content"].as_str().unwrap();
        assert!(prompt.contains("[Source 1]"));
        assert!(prompt.contains("[Source 2]"));
        assert!(prompt.contains("alpha evidence"));
        assert!(prompt.contains("beta evidence"));
        assert!(!prompt.contains("fusion-judge"));
        assert!(!prompt.contains("judge-model"));
        assert_eq!(judge["stream"], true);
    }
    assert_eq!(second_bodies.lock().unwrap().len(), 1);
    assert_eq!(slow_bodies.lock().unwrap().len(), 1);

    release_slow.notify_one();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let ledger: (i64, i64) = sqlx::query_as(
                "SELECT COUNT(*), COALESCE(SUM(tokens_input + tokens_output + tokens_reasoning),0) FROM redrouter_usage_ledger WHERE key_id = ?",
            )
            .bind("fusion-client")
            .fetch_one(&audit)
            .await
            .unwrap();
            if ledger == (4, 28) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("all physical fusion calls were not accounted");

    let judge_count = judge_bodies.lock().unwrap().len();
    let second_count = second_bodies.lock().unwrap().len();
    let slow_count = slow_bodies.lock().unwrap().len();
    let tool_response = chat_model_with_body(
        &client,
        &base,
        RUST_CLIENT_KEY,
        serde_json::json!({
            "model":"fusion-combo",
            "messages":[{"role":"user","content":"look this up"}],
            "tools":[{
                "type":"function",
                "function":{"name":"lookup","parameters":{"type":"object"}}
            }],
            "tool_choice":"auto"
        }),
    )
    .await;
    assert_eq!(tool_response.status(), StatusCode::OK);
    let tool_response: serde_json::Value = tool_response.json().await.unwrap();
    assert_eq!(
        tool_response["choices"][0]["message"]["content"],
        "alpha evidence"
    );
    assert_eq!(judge_bodies.lock().unwrap().len(), judge_count + 1);
    assert_eq!(second_bodies.lock().unwrap().len(), second_count);
    assert_eq!(slow_bodies.lock().unwrap().len(), slow_count);
    let last_judge = judge_bodies.lock().unwrap().last().unwrap().clone();
    assert_eq!(last_judge["tools"][0]["function"]["name"], "lookup");
    assert_eq!(last_judge["tool_choice"], "auto");

    let ledger: (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(tokens_input + tokens_output + tokens_reasoning),0) FROM redrouter_usage_ledger WHERE key_id = ?",
    )
    .bind("fusion-client")
    .fetch_one(&audit)
    .await
    .unwrap();
    assert_eq!(ledger, (5, 33));

    audit.close().await;
    gateway_task.abort();
    judge_task.abort();
    second_task.abort();
    slow_task.abort();
}

#[tokio::test]
async fn pipeline_chains_targets_retries_transients_streams_final_and_accounts_each_call() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("pipeline.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (draft_url, draft_bodies, draft_task) =
        pipeline_provider("pipeline-draft-secret", "draft-output", true).await;
    let (final_url, final_bodies, final_task) =
        pipeline_provider("pipeline-final-secret", "final-output", false).await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let audit = sqlx::SqlitePool::connect(&url).await.unwrap();

    for (id, upstream_url, api_key) in [
        ("pipeline-draft", draft_url, "pipeline-draft-secret"),
        ("pipeline-final", final_url, "pipeline-final-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"openai-compatible",
                    "upstream_url":upstream_url,
                    "api_key":api_key
                }))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/pipeline-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Pipeline workload",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["pipeline-combo","draft-model","final-model"],
                "allowed_provider_ids":["pipeline-draft","pipeline-final"],
                "max_tokens_per_minute":1000,
                "max_tokens_per_day":10000,
                "reservation_tokens":50
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let invalid = client
        .put(format!("{base}/api/admin/combos/pipeline-combo"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "strategy":"pipeline",
            "pipeline":{"maxRetries":11,"retryDelayMs":1},
            "targets":[
                {"provider_id":"pipeline-draft","model":"draft-model"},
                {"provider_id":"pipeline-final","model":"final-model"}
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

    let configured = client
        .put(format!("{base}/api/admin/combos/pipeline-combo"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "strategy":"pipeline",
            "fallback":true,
            "pipeline":{"maxRetries":1,"retryDelayMs":1},
            "targets":[
                {
                    "provider_id":"pipeline-draft",
                    "model":"draft-model",
                    "prompt":"  Produce a draft  "
                },
                {
                    "provider_id":"pipeline-final",
                    "model":"final-model",
                    "prompt":"  Polish the draft  "
                }
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(configured.status(), StatusCode::OK);
    let configured: serde_json::Value = configured.json().await.unwrap();
    assert_eq!(configured["combo"]["pipeline"]["maxRetries"], 1);
    assert_eq!(
        configured["combo"]["targets"][0]["prompt"],
        "Produce a draft"
    );

    let response = chat_model_with_body(
        &client,
        &base,
        RUST_CLIENT_KEY,
        serde_json::json!({
            "model":"pipeline-combo",
            "messages":[{"role":"user","content":"write the answer"}],
            "stream":true,
            "stream_options":{"include_usage":true},
            "tools":[{
                "type":"function",
                "function":{"name":"lookup","parameters":{"type":"object"}}
            }],
            "tool_choice":"auto"
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let response = response.text().await.unwrap();
    assert!(response.contains("final-output"));
    assert!(response.contains("data: [DONE]"));

    {
        let bodies = draft_bodies.lock().unwrap();
        assert_eq!(bodies.len(), 2);
        for body in bodies.iter() {
            assert_eq!(body["stream"], false);
            assert!(body.get("tools").is_none());
            assert!(body.get("tool_choice").is_none());
            assert!(body.get("stream_options").is_none());
            assert_eq!(body["messages"][0]["role"], "system");
            assert_eq!(body["messages"][0]["content"], "Produce a draft");
            assert_eq!(body["messages"][1]["content"], "write the answer");
        }
    }
    {
        let bodies = final_bodies.lock().unwrap();
        assert_eq!(bodies.len(), 1);
        let body = &bodies[0];
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "Polish the draft");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "draft-output");
        assert_eq!(body["tools"][0]["function"]["name"], "lookup");
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let ledger: (i64, i64) = sqlx::query_as(
                "SELECT COUNT(*), COALESCE(SUM(tokens_input + tokens_output + tokens_reasoning),0) FROM redrouter_usage_ledger WHERE key_id = ?",
            )
            .bind("pipeline-client")
            .fetch_one(&audit)
            .await
            .unwrap();
            if ledger == (2, 10) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("all successful physical pipeline calls were not accounted");

    audit.close().await;
    gateway_task.abort();
    draft_task.abort();
    final_task.abort();
}

#[tokio::test]
async fn context_relay_persists_session_and_injects_handoff_on_model_switch() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("context-relay.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (first_url, first_bodies, first_task) =
        captured_provider("relay-first-secret", "relay-first").await;
    let (second_url, second_bodies, second_task) =
        captured_provider("relay-second-secret", "relay-second").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let persisted_state = sqlx::SqlitePool::connect(&url).await.unwrap();

    for (id, upstream_url, api_key) in [
        ("relay-first", first_url, "relay-first-secret"),
        ("relay-second", second_url, "relay-second-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .json(&serde_json::json!({
                    "provider":"openai-compatible",
                    "upstream_url":upstream_url,
                    "api_key":api_key
                }))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/relay-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Relay client",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["relay-combo","shared-model"],
                "allowed_provider_ids":["relay-first","relay-second"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let replace_combo = |provider_id: &str, model: &str| {
        client
            .put(format!("{base}/api/admin/combos/relay-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"context-relay",
                "fallback":true,
                "context_relay":{
                    "handoffThreshold":0.8,
                    "handoffModel":"  shared-model  ",
                    "handoffProviders":[" OPENAI-COMPATIBLE ","openai-compatible","OpenAI"],
                    "maxMessagesForSummary":24,
                    "relayMode":"schema-locked"
                },
                "targets":[{"provider_id":provider_id,"model":model}]
            }))
    };
    let configured = replace_combo("relay-first", "shared-model")
        .send()
        .await
        .unwrap();
    assert_eq!(configured.status(), StatusCode::OK);
    let configured: serde_json::Value = configured.json().await.unwrap();
    assert_eq!(
        configured["combo"]["context_relay"]["handoffThreshold"],
        0.8
    );
    assert_eq!(
        configured["combo"]["context_relay"]["handoffModel"],
        "shared-model"
    );
    assert_eq!(
        configured["combo"]["context_relay"]["handoffProviders"],
        serde_json::json!(["openai-compatible", "openai"])
    );
    assert_eq!(
        configured["combo"]["context_relay"]["maxMessagesForSummary"],
        24
    );
    assert_eq!(
        configured["combo"]["context_relay"]["relayMode"],
        "schema-locked"
    );
    let first = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header("x-omniroute-session-id", "agent-session-1")
        .json(&serde_json::json!({
            "model":"relay-combo",
            "messages":[{"role":"user","content":"continue the migration"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(first.text().await.unwrap(), "relay-first");
    assert_eq!(
        first_bodies.lock().unwrap()[0]["messages"][0]["role"],
        "user"
    );

    assert_eq!(
        replace_combo("relay-second", "shared-model")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let second = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header("x-session-id", "agent-session-1")
        .json(&serde_json::json!({
            "model":"relay-combo",
            "messages":[{"role":"user","content":"what is next?"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(second.text().await.unwrap(), "relay-second");
    {
        let bodies = second_bodies.lock().unwrap();
        let messages = bodies[0]["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "system");
        let handoff = messages[0]["content"].as_str().unwrap();
        assert!(handoff.contains("<previous_model>shared-model</previous_model>"));
        assert!(handoff.contains("<current_model>shared-model</current_model>"));
        assert_eq!(messages[1]["content"], "what is next?");
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if second_bodies.lock().unwrap().len() >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Rust context relay summary generation timed out");
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let persisted: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM redrouter_context_relay_handoffs WHERE combo_id = ?",
            )
            .bind("relay-combo")
            .fetch_one(&persisted_state)
            .await
            .unwrap();
            if persisted == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Rust context relay summary persistence timed out");
    let relay_usage: (i64, String, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(MIN(key_name),''), COALESCE(SUM(tokens_input),0), COALESCE(SUM(tokens_output),0) FROM redrouter_usage_ledger WHERE key_id = ?",
    )
    .bind("redrouter-context-relay")
    .fetch_one(&persisted_state)
    .await
    .unwrap();
    assert_eq!(
        relay_usage,
        (1, "Red Router context relay".to_owned(), 11, 7)
    );
    let client_usage: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_usage_ledger WHERE key_id = ?")
            .bind("relay-client")
            .fetch_one(&persisted_state)
            .await
            .unwrap();
    assert_eq!(client_usage, 0);
    {
        let bodies = second_bodies.lock().unwrap();
        assert_eq!(bodies[1]["model"], "shared-model");
        assert_eq!(bodies[1]["stream"], false);
        assert!(bodies[1]["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("CONVERSATION HISTORY"));
    }

    assert_eq!(
        replace_combo("relay-first", "shared-model")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let third = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header("x-session-id", "agent-session-1")
        .json(&serde_json::json!({
            "model":"relay-combo",
            "messages":[{"role":"user","content":"continue after the summary"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(third.status(), StatusCode::OK);
    assert_eq!(third.text().await.unwrap(), "relay-first");
    {
        let bodies = first_bodies.lock().unwrap();
        let messages = bodies[1]["messages"].as_array().unwrap();
        let handoff = messages[0]["content"].as_str().unwrap();
        assert!(handoff.contains("<session_summary>The user is migrating"));
        assert!(handoff.contains("<key_decisions>"));
        assert!(handoff.contains("Rust owns proxy persistence"));
        assert!(handoff.contains("<summary_source_model>shared-model</summary_source_model>"));
        assert_eq!(messages[1]["content"], "continue after the summary");
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    assert_eq!(
        set_provider_quota(
            &client,
            &base,
            "relay-first",
            serde_json::json!({
                "session":{"remaining_percent":15.0,"reset_at_unix_ms":now + 3_600_000},
                "ttl_seconds":600
            }),
        )
        .await,
        StatusCode::OK
    );
    let quota_warning = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header("x-session-id", "quota-warning-session")
        .json(&serde_json::json!({
            "model":"relay-combo",
            "messages":[{"role":"user","content":"prepare before account rotation"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(quota_warning.status(), StatusCode::OK);
    assert_eq!(quota_warning.text().await.unwrap(), "relay-first");
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let persisted: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM redrouter_context_relay_handoffs WHERE combo_id = ?",
            )
            .bind("relay-combo")
            .fetch_one(&persisted_state)
            .await
            .unwrap();
            if persisted == 2 && first_bodies.lock().unwrap().len() >= 4 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|error| panic!("Rust quota-warning handoff pre-generation timed out: {error}; captured upstream requests={}", first_bodies.lock().unwrap().len()));
    assert!(first_bodies.lock().unwrap()[3]["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("prepare before account rotation"));

    assert_eq!(
        replace_combo("relay-second", "shared-model")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let rotated = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header("x-session-id", "quota-warning-session")
        .json(&serde_json::json!({
            "model":"relay-combo",
            "messages":[{"role":"user","content":"continue on the next account"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(rotated.status(), StatusCode::OK);
    assert_eq!(rotated.text().await.unwrap(), "relay-second");
    assert!(second_bodies.lock().unwrap()[2]["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("<session_summary>The user is migrating"));

    let invalid = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(RUST_CLIENT_KEY)
        .header("x-session-id", "one")
        .header("x-omniroute-session-id", "two")
        .json(&serde_json::json!({"model":"relay-combo","messages":[]}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    assert_eq!(second_bodies.lock().unwrap().len(), 3);

    let invalid_config = client
        .put(format!("{base}/api/admin/combos/relay-combo"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "strategy":"priority",
            "context_relay":{
                "handoffThreshold":0.8,
                "handoffProviders":["codex"],
                "maxMessagesForSummary":30,
                "relayMode":"standard"
            },
            "targets":[{"provider_id":"relay-second","model":"second-model"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_config.status(), StatusCode::BAD_REQUEST);

    gateway_task.abort();
    first_task.abort();
    second_task.abort();
    persisted_state.close().await;
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
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/agent-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"cache-optimized",
                    "fallback":true,
                    "targets":[
                        {"provider_id":"first","model":"upstream-model"},
                        {"provider_id":"second","model":"upstream-model"}
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
    let stable = chat_model_with_body(
        &client,
        &base,
        RUST_CLIENT_KEY,
        serde_json::json!({
            "model":"agent-combo",
            "messages":[],
            "prompt_cache_key":"stable-agent-session"
        }),
    )
    .await
    .text()
    .await
    .unwrap();
    for _ in 0..4 {
        assert_eq!(
            chat_model_with_body(
                &client,
                &base,
                RUST_CLIENT_KEY,
                serde_json::json!({
                    "model":"agent-combo",
                    "messages":[],
                    "metadata":{"prompt_cache_key":"stable-agent-session"}
                }),
            )
            .await
            .text()
            .await
            .unwrap(),
            stable
        );
    }
    let prefix_first = chat_model_with_body(
        &client,
        &base,
        RUST_CLIENT_KEY,
        serde_json::json!({
            "model":"agent-combo",
            "messages":[
                {"role":"system","content":"stable tools and instructions"},
                {"role":"user","content":"first question"}
            ]
        }),
    )
    .await
    .text()
    .await
    .unwrap();
    assert_eq!(
        chat_model_with_body(
            &client,
            &base,
            RUST_CLIENT_KEY,
            serde_json::json!({
                "model":"agent-combo",
                "messages":[
                    {"role":"system","content":"stable tools and instructions"},
                    {"role":"user","content":"different question"}
                ]
            }),
        )
        .await
        .text()
        .await
        .unwrap(),
        prefix_first
    );
    let mut cache_targets = std::collections::HashSet::new();
    for index in 0..32 {
        cache_targets.insert(
            chat_model_with_body(
                &client,
                &base,
                RUST_CLIENT_KEY,
                serde_json::json!({
                    "model":"agent-combo",
                    "messages":[],
                    "prompt_cache_key":format!("independent-session-{index}")
                }),
            )
            .await
            .text()
            .await
            .unwrap(),
        );
    }
    assert_eq!(cache_targets.len(), 2);
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/agent-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"auto",
                    "fallback":true,
                    "auto":{"weights":{"quota":0.0,"cost":0.0,"context":1.0,"load":0.0}},
                    "targets":[
                        {
                            "provider_id":"first",
                            "model":"upstream-model",
                            "input_cost_per_million":0.0,
                            "output_cost_per_million":0.0,
                            "context_window_tokens":128000
                        },
                        {
                            "provider_id":"second",
                            "model":"upstream-model",
                            "input_cost_per_million":100.0,
                            "output_cost_per_million":100.0,
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
    let persisted_auto = database
        .combos()
        .await
        .unwrap()
        .into_iter()
        .find(|combo| combo.id == "agent-combo")
        .unwrap();
    let persisted_auto: serde_json::Value =
        serde_json::from_str(&persisted_auto.targets_json).unwrap();
    assert_eq!(persisted_auto["auto"]["weights"]["context"], 1.0);
    let reloaded_control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (reloaded_auto_base, reloaded_auto_task) = gateway(reloaded_control).await;
    assert_eq!(
        chat_model(&client, &reloaded_auto_base, RUST_CLIENT_KEY, "agent-combo")
            .await
            .text()
            .await
            .unwrap(),
        "combo-second"
    );
    reloaded_auto_task.abort();
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/agent-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"priority",
                    "auto":{"weights":{"quota":0.25,"cost":0.25,"context":0.25,"load":0.25}},
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
async fn rust_control_plane_isolates_provider_and_combo_routes_by_tenant() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("tenant-routes.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (red_url, red_task) = provider("red-provider-secret", "red").await;
    let (acme_url, acme_task) = provider("acme-provider-secret", "acme").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    assert_eq!(
        client
            .put(format!("{base}/api/admin/tenants/acme"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(r#"{"slug":"acme","name":"Acme"}"#)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for (id, tenant_id, upstream_url, api_key) in [
        ("red-provider", "red", red_url, "red-provider-secret"),
        ("acme-provider", "acme", acme_url, "acme-provider-secret"),
    ] {
        let response = client
            .put(format!("{base}/api/admin/providers/{id}"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "tenant_id":tenant_id,
                    "provider":"openai",
                    "upstream_url":upstream_url,
                    "api_key":api_key
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response: serde_json::Value =
            serde_json::from_str(&response.text().await.unwrap()).unwrap();
        assert_eq!(response["provider"]["tenant_id"], tenant_id);
    }

    let cross_tenant = client
        .put(format!("{base}/api/admin/combos/cross-tenant"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "tenant_id":"acme",
                "targets":[{"provider_id":"red-provider","model":"gpt-4o"}]
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(cross_tenant.status(), StatusCode::BAD_REQUEST);

    for (combo, tenant_id, provider_id) in [
        ("red-combo", "red", "red-provider"),
        ("acme-combo", "acme", "acme-provider"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/combos/{combo}"))
                .bearer_auth(ADMIN_KEY)
                .header(header::CONTENT_TYPE.as_str(), "application/json")
                .body(
                    serde_json::json!({
                        "tenant_id":tenant_id,
                        "targets":[{"provider_id":provider_id,"model":"gpt-4o"}]
                    })
                    .to_string(),
                )
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }

    for (id, label, tenant_id, key) in [
        ("red-key", "Red key", "red", "red-tenant-key-1234567890"),
        ("acme-key", "Acme key", "acme", "acme-tenant-key-1234567890"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/client-keys/{id}"))
                .bearer_auth(ADMIN_KEY)
                .header(header::CONTENT_TYPE.as_str(), "application/json")
                .body(
                    serde_json::json!({
                        "label":label,
                        "tenant_id":tenant_id,
                        "api_key":key,
                        "scopes":["inference:chat"]
                    })
                    .to_string(),
                )
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }

    for (key, own_combo, hidden_combo, expected) in [
        (
            "red-tenant-key-1234567890",
            "red-combo",
            "acme-combo",
            "red",
        ),
        (
            "acme-tenant-key-1234567890",
            "acme-combo",
            "red-combo",
            "acme",
        ),
    ] {
        let models = client
            .get(format!("{base}/v1/models"))
            .bearer_auth(key)
            .send()
            .await
            .unwrap();
        assert_eq!(models.status(), StatusCode::OK);
        let models: serde_json::Value =
            serde_json::from_str(&models.text().await.unwrap()).unwrap();
        let ids = models["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|model| model["id"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![own_combo]);
        assert_eq!(
            chat_model(&client, &base, key, own_combo)
                .await
                .text()
                .await
                .unwrap(),
            expected
        );
        assert_eq!(
            chat_model(&client, &base, key, hidden_combo).await.status(),
            StatusCode::NOT_FOUND
        );
    }

    let stored_providers = database.providers().await.unwrap();
    assert_eq!(stored_providers[0].tenant_id, "acme");
    assert_eq!(stored_providers[1].tenant_id, "red");
    let stored_combos = database.combos().await.unwrap();
    assert!(stored_combos
        .iter()
        .any(|combo| combo.id == "acme-combo" && combo.tenant_id == "acme"));

    gateway_task.abort();
    red_task.abort();
    acme_task.abort();
}

#[tokio::test]
async fn rust_imports_codex_cli_auth_without_nextjs_or_token_disclosure() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("codex-import.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let (token_endpoint, _, _, _, token_task) = claude_oauth_refresh_server().await;
    let control = ControlPlane::new_with_oauth_refresh_endpoints(
        database.clone(),
        ADMIN_KEY,
        STORAGE_KEY,
        false,
        token_endpoint.clone(),
        token_endpoint,
    )
    .await
    .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3_600;
    let id_token = unverified_jwt(serde_json::json!({
        "email":"codex@example.com",
        "sub":"user-one",
        "exp":expiry,
        "https://api.openai.com/auth":{
            "chatgpt_account_id":"workspace-one",
            "chatgpt_user_id":"user-one"
        }
    }));
    let access_token = unverified_jwt(serde_json::json!({"exp":expiry}));
    let auth_file = serde_json::json!({
        "auth_mode":"chatgpt",
        "tokens":{
            "id_token":id_token.clone(),
            "access_token":access_token.clone(),
            "refresh_token":"codex-refresh-secret",
            "account_id":"workspace-one"
        }
    });
    let imported = client
        .post(format!("{base}/api/providers/codex-auth/import"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "source":{"kind":"json","json":auth_file.clone()},
                "name":"Primary Codex"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(imported.status(), StatusCode::OK);
    assert_eq!(
        imported.headers()[header::CACHE_CONTROL],
        HeaderValue::from_static("no-store")
    );
    let imported: serde_json::Value =
        serde_json::from_str(&imported.text().await.unwrap()).unwrap();
    assert_eq!(imported["created"], true);
    assert_eq!(imported["connection"]["provider"], "codex");
    assert_eq!(imported["connection"]["label"], "Primary Codex");
    assert_eq!(imported["connection"]["account_email"], "codex@example.com");
    assert!(!imported.to_string().contains("codex-refresh-secret"));
    assert!(!imported.to_string().contains(&access_token));
    let provider_id = imported["connection"]["id"].as_str().unwrap().to_owned();

    let duplicate = client
        .post(format!("{base}/api/providers/codex-auth/import"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(serde_json::json!({"source":{"kind":"json","json":auth_file.clone()}}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    let duplicate: serde_json::Value =
        serde_json::from_str(&duplicate.text().await.unwrap()).unwrap();
    assert_eq!(duplicate["code"], "duplicate_account");

    let overwritten = client
        .post(format!("{base}/api/providers/codex-auth/import"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "source":{"kind":"json","json":auth_file},
                "overwriteExisting":true
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(overwritten.status(), StatusCode::OK);
    let overwritten: serde_json::Value =
        serde_json::from_str(&overwritten.text().await.unwrap()).unwrap();
    assert_eq!(overwritten["created"], false);
    assert_eq!(overwritten["connection"]["id"], provider_id);

    let second_id_token = unverified_jwt(serde_json::json!({
        "email":"second@example.com",
        "sub":"user-two",
        "exp":expiry,
        "https://api.openai.com/auth":{
            "chatgpt_account_id":"workspace-one",
            "chatgpt_user_id":"user-two"
        }
    }));
    let second_auth = serde_json::json!({
        "tokens":{
            "id_token":second_id_token,
            "access_token":access_token.clone(),
            "refresh_token":"second-refresh-secret"
        }
    });
    let bulk = client
        .post(format!("{base}/api/providers/codex-auth/import-bulk"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "entries":[
                    {"json":second_auth,"name":"Second Codex"},
                    {"json":{"tokens":{}},"name":"Broken"}
                ]
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(bulk.status(), StatusCode::OK);
    let bulk: serde_json::Value = serde_json::from_str(&bulk.text().await.unwrap()).unwrap();
    assert_eq!(bulk["success"], 1);
    assert_eq!(bulk["failed"], 1);
    assert_eq!(bulk["errors"][0]["index"], 1);

    let providers = database.providers().await.unwrap();
    assert_eq!(providers.len(), 2);
    assert!(providers
        .iter()
        .all(|provider| provider.provider == "codex"));
    let oauth = database.provider_oauth().await.unwrap();
    assert_eq!(oauth.len(), 2);
    assert!(oauth
        .iter()
        .all(|record| record.refresh_token_ciphertext.starts_with("rr:v1:")));
    assert!(oauth
        .iter()
        .all(|record| !record.refresh_token_ciphertext.contains("refresh-secret")));

    let audit = client
        .get(format!(
            "{base}/api/admin/audit-log?action=provider.credentials.imported&target={provider_id}"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(audit.status(), StatusCode::OK);
    let audit: serde_json::Value = serde_json::from_str(&audit.text().await.unwrap()).unwrap();
    assert_eq!(audit.as_array().unwrap().len(), 2);
    assert!(!audit.to_string().contains("refresh-secret"));

    gateway_task.abort();
    token_task.abort();
}

#[tokio::test]
async fn rust_collects_codex_quota_with_cli_identity_and_durable_cooldown() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("codex-quota.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let (quota_endpoint, quota_requests, headers_seen, quota_task) = codex_quota_server().await;
    let control = ControlPlane::new_with_oauth_refresh_endpoints(
        database.clone(),
        ADMIN_KEY,
        STORAGE_KEY,
        false,
        quota_endpoint.clone(),
        quota_endpoint,
    )
    .await
    .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3_600;
    let id_token = unverified_jwt(serde_json::json!({
        "email":"quota@example.com",
        "sub":"quota-user",
        "exp":expiry,
        "https://api.openai.com/auth":{
            "chatgpt_account_id":"quota-workspace",
            "chatgpt_user_id":"quota-user"
        }
    }));
    let access_token = unverified_jwt(serde_json::json!({"exp":expiry}));
    let imported = client
        .post(format!("{base}/api/providers/codex-auth/import"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "source":{"kind":"json","json":{
                "auth_mode":"chatgpt",
                "tokens":{
                    "id_token":id_token,
                    "access_token":access_token.clone(),
                    "refresh_token":"quota-refresh-secret"
                }
            }}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(imported.status(), StatusCode::OK);
    let imported: serde_json::Value = imported.json().await.unwrap();
    let provider_id = imported["connection"]["id"].as_str().unwrap();

    let unauthorized = client
        .post(format!(
            "{base}/api/admin/provider-quotas/{provider_id}/refresh"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let refreshed = client
        .post(format!(
            "{base}/api/admin/provider-quotas/{provider_id}/refresh"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(refreshed.status(), StatusCode::OK);
    let refreshed: serde_json::Value = refreshed.json().await.unwrap();
    assert_eq!(refreshed["refresh"]["refreshed"], true);
    assert_eq!(refreshed["refresh"]["category"], "refreshed");
    assert_eq!(
        refreshed["refresh"]["quota"]["session"]["remaining_percent"],
        20.0
    );
    assert_eq!(
        refreshed["refresh"]["quota"]["weekly"]["remaining_percent"],
        60.0
    );
    assert!(!refreshed.to_string().contains("quota-refresh-secret"));
    assert_eq!(quota_requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        headers_seen.lock().unwrap().as_slice(),
        [(
            format!("Bearer {access_token}"),
            "quota-workspace".to_owned(),
            "codex_cli_rs/0.163.0".to_owned(),
            "codex_cli_rs".to_owned()
        )]
    );

    let cooling_down = client
        .post(format!(
            "{base}/api/admin/provider-quotas/{provider_id}/refresh"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(cooling_down.status(), StatusCode::OK);
    let cooling_down: serde_json::Value = cooling_down.json().await.unwrap();
    assert_eq!(cooling_down["refresh"]["refreshed"], false);
    assert_eq!(cooling_down["refresh"]["category"], "refresh_in_progress");
    assert_eq!(quota_requests.load(Ordering::SeqCst), 1);

    let listed = client
        .get(format!("{base}/api/admin/provider-quotas"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    let listed: serde_json::Value = listed.json().await.unwrap();
    assert_eq!(listed["provider_quotas"][0]["provider_id"], provider_id);
    assert_eq!(database.provider_quotas().await.unwrap().len(), 1);

    gateway_task.abort();
    quota_task.abort();
}

#[tokio::test]
async fn rust_extracts_auth_zip_for_codex_and_claude_with_bounded_safe_entries() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("auth-zip.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let archive = auth_zip(&[
        (
            "accounts/primary.json",
            br#"{"tokens":{"access_token":"secret"}}"#,
        ),
        ("broken.JSON", b"not-json"),
        ("ignored.txt", b"ignored"),
    ]);

    let unauthorized = client
        .post(format!("{base}/api/providers/codex-auth/zip-extract"))
        .body(archive.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    for provider in ["codex", "claude"] {
        let response = client
            .post(format!("{base}/api/providers/{provider}-auth/zip-extract"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/zip")
            .body(archive.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            HeaderValue::from_static("no-store")
        );
        let response: serde_json::Value =
            serde_json::from_str(&response.text().await.unwrap()).unwrap();
        assert_eq!(response["entries"].as_array().unwrap().len(), 2);
        assert_eq!(response["entries"][0]["name"], "primary.json");
        assert_eq!(
            response["entries"][0]["json"]["tokens"]["access_token"],
            "secret"
        );
        assert_eq!(
            response["entries"][0]["parseError"],
            serde_json::Value::Null
        );
        assert_eq!(response["entries"][1]["name"], "broken.JSON");
        assert_eq!(response["entries"][1]["json"], serde_json::Value::Null);
        assert_eq!(response["entries"][1]["parseError"], "Not valid JSON");
    }

    let traversal = auth_zip(&[("../escape.json", br#"{"ok":true}"#)]);
    let rejected = client
        .post(format!("{base}/api/providers/codex-auth/zip-extract"))
        .bearer_auth(ADMIN_KEY)
        .body(traversal)
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    let rejected: serde_json::Value =
        serde_json::from_str(&rejected.text().await.unwrap()).unwrap();
    assert_eq!(rejected["code"], "extract_failed");
    assert_eq!(
        rejected["error"],
        "ZIP archive contains an unsafe entry path"
    );

    let many_entries = (0..=50)
        .map(|index| (format!("account-{index}.json"), b"{}".to_vec()))
        .collect::<Vec<_>>();
    let many_entry_refs = many_entries
        .iter()
        .map(|(name, content)| (name.as_str(), content.as_slice()))
        .collect::<Vec<_>>();
    let rejected = client
        .post(format!("{base}/api/providers/claude-auth/zip-extract"))
        .bearer_auth(ADMIN_KEY)
        .body(auth_zip(&many_entry_refs))
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    let rejected: serde_json::Value =
        serde_json::from_str(&rejected.text().await.unwrap()).unwrap();
    assert_eq!(rejected["code"], "extract_failed");
    assert_eq!(
        rejected["error"],
        "ZIP archive contains more than 50 .json files"
    );

    gateway_task.abort();
}

#[tokio::test]
async fn rust_owns_provider_browser_oauth_across_replicas() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("browser-oauth.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let (
        codex_endpoint,
        claude_endpoint,
        codex_requests,
        claude_requests,
        agy_requests,
        xai_requests,
        openference_requests,
        oauth_task,
    ) = provider_browser_oauth_server().await;
    let first = ControlPlane::new_with_oauth_refresh_endpoints(
        database.clone(),
        ADMIN_KEY,
        STORAGE_KEY,
        false,
        codex_endpoint.clone(),
        claude_endpoint.clone(),
    )
    .await
    .unwrap();
    let second = ControlPlane::new_with_oauth_refresh_endpoints(
        database.clone(),
        ADMIN_KEY,
        STORAGE_KEY,
        false,
        codex_endpoint,
        claude_endpoint,
    )
    .await
    .unwrap();
    let (first_base, first_task) = gateway(first).await;
    let (second_base, second_task) = gateway(second).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    let unauthorized = client
        .get(format!("{first_base}/api/oauth/codex/authorize"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let codex_authorize = client
        .get(format!("{first_base}/api/oauth/codex/authorize"))
        .bearer_auth(ADMIN_KEY)
        .query(&[("redirect_uri", "http://localhost:1455/auth/callback")])
        .send()
        .await
        .unwrap();
    assert_eq!(codex_authorize.status(), StatusCode::OK);
    assert_eq!(
        codex_authorize.headers()[header::CACHE_CONTROL],
        HeaderValue::from_static("no-store")
    );
    let codex_authorize: serde_json::Value =
        serde_json::from_str(&codex_authorize.text().await.unwrap()).unwrap();
    assert_eq!(
        codex_authorize["redirectUri"],
        "http://localhost:1455/auth/callback"
    );
    assert_eq!(codex_authorize["fixedPort"], 1455);
    assert_eq!(codex_authorize["codeVerifier"].as_str().unwrap().len(), 43);
    assert_eq!(codex_authorize["codeChallenge"].as_str().unwrap().len(), 43);
    let codex_state = codex_authorize["state"].as_str().unwrap().to_owned();
    let codex_verifier = codex_authorize["codeVerifier"].as_str().unwrap().to_owned();
    assert!(!codex_state.contains(&codex_verifier));
    let codex_url = Url::parse(codex_authorize["authUrl"].as_str().unwrap()).unwrap();
    let codex_query: std::collections::HashMap<_, _> =
        codex_url.query_pairs().into_owned().collect();
    assert_eq!(codex_query["state"], codex_state);
    assert_eq!(
        codex_query["code_challenge"],
        codex_authorize["codeChallenge"]
    );
    assert_eq!(codex_query["prompt"], "login");

    let mut wrong_verifier = codex_verifier.clone();
    wrong_verifier.replace_range(
        42..43,
        if wrong_verifier.ends_with('A') {
            "B"
        } else {
            "A"
        },
    );
    let rejected = client
        .post(format!("{second_base}/api/oauth/codex/exchange"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "code":"codex-browser-code",
            "redirectUri":"http://localhost:1455/auth/callback",
            "codeVerifier":wrong_verifier,
            "state":codex_state
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    assert_eq!(codex_requests.load(Ordering::SeqCst), 0);

    let codex_exchange = client
        .post(format!("{second_base}/api/oauth/codex/exchange"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "code":"codex-browser-code",
            "redirectUri":"http://localhost:1455/auth/callback",
            "codeVerifier":codex_verifier,
            "state":codex_state
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(codex_exchange.status(), StatusCode::OK);
    assert_eq!(
        codex_exchange.headers()[header::CACHE_CONTROL],
        HeaderValue::from_static("no-store")
    );
    let codex_exchange: serde_json::Value =
        serde_json::from_str(&codex_exchange.text().await.unwrap()).unwrap();
    assert_eq!(codex_exchange["success"], true);
    assert_eq!(codex_exchange["connection"]["provider"], "codex");
    assert_eq!(
        codex_exchange["connection"]["email"],
        "browser-codex@example.com"
    );
    let codex_provider_id = codex_exchange["connection"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(!codex_exchange.to_string().contains("browser-refresh"));
    assert_eq!(codex_requests.load(Ordering::SeqCst), 1);

    let claude_authorize = client
        .get(format!("{first_base}/api/oauth/claude/authorize"))
        .bearer_auth(ADMIN_KEY)
        .query(&[("redirect_uri", "https://router.example/callback")])
        .send()
        .await
        .unwrap();
    assert_eq!(claude_authorize.status(), StatusCode::OK);
    let claude_authorize: serde_json::Value =
        serde_json::from_str(&claude_authorize.text().await.unwrap()).unwrap();
    assert_eq!(
        claude_authorize["redirectUri"],
        "https://platform.claude.com/oauth/code/callback"
    );
    let claude_state = claude_authorize["state"].as_str().unwrap().to_owned();
    let claude_verifier = claude_authorize["codeVerifier"]
        .as_str()
        .unwrap()
        .to_owned();
    let claude_exchange = client
        .post(format!("{second_base}/api/oauth/claude/exchange"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "code":format!("claude-browser-code#{claude_state}"),
            "redirectUri":"https://platform.claude.com/oauth/code/callback",
            "codeVerifier":claude_verifier
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(claude_exchange.status(), StatusCode::OK);
    let claude_exchange: serde_json::Value =
        serde_json::from_str(&claude_exchange.text().await.unwrap()).unwrap();
    assert_eq!(claude_exchange["success"], true);
    assert_eq!(claude_exchange["connection"]["provider"], "claude");
    assert_eq!(
        claude_exchange["connection"]["email"],
        "browser-claude@example.com"
    );
    let claude_provider_id = claude_exchange["connection"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(!claude_exchange.to_string().contains("browser-refresh"));
    assert_eq!(claude_requests.load(Ordering::SeqCst), 1);

    let agy_authorize = client
        .get(format!("{first_base}/api/oauth/agy/authorize"))
        .bearer_auth(ADMIN_KEY)
        .query(&[("redirect_uri", "http://127.0.0.1:9876/callback")])
        .send()
        .await
        .unwrap();
    assert_eq!(agy_authorize.status(), StatusCode::OK);
    let agy_authorize: serde_json::Value =
        serde_json::from_str(&agy_authorize.text().await.unwrap()).unwrap();
    assert_eq!(agy_authorize["flowType"], "authorization_code");
    assert_eq!(
        agy_authorize["redirectUri"],
        "http://127.0.0.1:9876/callback"
    );
    let agy_state = agy_authorize["state"].as_str().unwrap().to_owned();
    let agy_verifier = agy_authorize["codeVerifier"].as_str().unwrap().to_owned();
    let agy_url = Url::parse(agy_authorize["authUrl"].as_str().unwrap()).unwrap();
    assert_eq!(agy_url.host_str(), Some("accounts.google.com"));
    let agy_query: std::collections::HashMap<_, _> = agy_url.query_pairs().into_owned().collect();
    assert_eq!(agy_query["access_type"], "offline");
    assert_eq!(agy_query["prompt"], "consent");
    assert!(!agy_query.contains_key("code_challenge"));
    assert!(!agy_query["scope"]
        .split_whitespace()
        .any(|scope| scope == "openid"));

    let mismatched_reauth = client
        .post(format!("{second_base}/api/oauth/agy/exchange"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "code":"agy-browser-code",
            "redirectUri":"http://127.0.0.1:9876/callback",
            "codeVerifier":agy_verifier,
            "state":agy_state,
            "connectionId":claude_provider_id
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(mismatched_reauth.status(), StatusCode::BAD_REQUEST);
    assert_eq!(database.providers().await.unwrap().len(), 2);

    let agy_exchange = client
        .post(format!("{second_base}/api/oauth/agy/exchange"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "code":"agy-browser-code",
            "redirectUri":"http://127.0.0.1:9876/callback",
            "codeVerifier":agy_verifier,
            "state":agy_state
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(agy_exchange.status(), StatusCode::OK);
    let agy_exchange: serde_json::Value =
        serde_json::from_str(&agy_exchange.text().await.unwrap()).unwrap();
    assert_eq!(agy_exchange["success"], true);
    assert_eq!(agy_exchange["connection"]["provider"], "agy");
    assert_eq!(
        agy_exchange["connection"]["email"],
        "browser-agy@example.com"
    );
    assert!(!agy_exchange.to_string().contains("agy-browser-refresh"));
    assert_eq!(agy_requests.load(Ordering::SeqCst), 2);

    let xai_authorize = client
        .get(format!("{first_base}/api/oauth/xai-oauth/authorize"))
        .bearer_auth(ADMIN_KEY)
        .query(&[("redirect_uri", "http://127.0.0.1:56121/callback")])
        .send()
        .await
        .unwrap();
    assert_eq!(xai_authorize.status(), StatusCode::OK);
    let xai_authorize: serde_json::Value = xai_authorize.json().await.unwrap();
    assert_eq!(xai_authorize["flowType"], "authorization_code_pkce");
    assert_eq!(xai_authorize["fixedPort"], 56121);
    assert_eq!(xai_authorize["callbackHost"], "127.0.0.1");
    let xai_url = Url::parse(xai_authorize["authUrl"].as_str().unwrap()).unwrap();
    assert_eq!(xai_url.host_str(), Some("auth.x.ai"));
    let xai_query: std::collections::HashMap<_, _> = xai_url.query_pairs().into_owned().collect();
    assert_eq!(xai_query["client_id"], "test-xai-client");
    assert_eq!(xai_query["plan"], "generic");
    assert_eq!(xai_query["referrer"], "cli-proxy-api");
    assert_eq!(xai_query["code_challenge_method"], "S256");
    assert!(!xai_query.contains_key("prompt"));
    assert!(xai_query["scope"]
        .split_whitespace()
        .any(|scope| scope == "api:access"));
    assert_eq!(xai_query["nonce"].len(), 22);

    let xai_exchange = client
        .post(format!("{second_base}/api/oauth/xai-oauth/exchange"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "code":"xai-browser-code",
            "redirectUri":"http://127.0.0.1:56121/callback",
            "codeVerifier":xai_authorize["codeVerifier"],
            "state":xai_authorize["state"]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(xai_exchange.status(), StatusCode::OK);
    let xai_exchange: serde_json::Value = xai_exchange.json().await.unwrap();
    assert_eq!(xai_exchange["success"], true);
    assert_eq!(xai_exchange["connection"]["provider"], "xai-oauth");
    assert_eq!(
        xai_exchange["connection"]["email"],
        "browser-xai@example.com"
    );
    assert!(xai_exchange["connection"]["id"]
        .as_str()
        .unwrap()
        .starts_with("xai-"));
    assert!(!xai_exchange.to_string().contains("xai-browser-refresh"));
    assert_eq!(xai_requests.load(Ordering::SeqCst), 1);

    let openference_authorize = client
        .get(format!("{first_base}/api/oauth/openference/authorize"))
        .bearer_auth(ADMIN_KEY)
        .query(&[("redirect_uri", "http://127.0.0.1:56123/callback")])
        .send()
        .await
        .unwrap();
    assert_eq!(openference_authorize.status(), StatusCode::OK);
    let openference_authorize: serde_json::Value = openference_authorize.json().await.unwrap();
    assert_eq!(openference_authorize["flowType"], "authorization_code_pkce");
    assert_eq!(openference_authorize["fixedPort"], 56123);
    assert_eq!(openference_authorize["callbackHost"], "127.0.0.1");
    let openference_url = Url::parse(openference_authorize["authUrl"].as_str().unwrap()).unwrap();
    assert_eq!(openference_url.host_str(), Some("openference.com"));
    let openference_query: std::collections::HashMap<_, _> =
        openference_url.query_pairs().into_owned().collect();
    assert_eq!(openference_query["client_id"], "omniroute");
    assert_eq!(openference_query["code_challenge_method"], "S256");
    assert!(!openference_query.contains_key("prompt"));
    assert!(openference_query["scope"]
        .split_whitespace()
        .any(|scope| scope == "model:invoke"));

    let openference_exchange = client
        .post(format!("{second_base}/api/oauth/openference/exchange"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "code":"openference-browser-code",
            "redirectUri":"http://127.0.0.1:56123/callback",
            "codeVerifier":openference_authorize["codeVerifier"],
            "state":openference_authorize["state"]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(openference_exchange.status(), StatusCode::OK);
    let openference_exchange: serde_json::Value = openference_exchange.json().await.unwrap();
    assert_eq!(openference_exchange["success"], true);
    assert_eq!(
        openference_exchange["connection"]["provider"],
        "openference"
    );
    assert_eq!(
        openference_exchange["connection"]["email"],
        "browser-openference@example.com"
    );
    let openference_provider_id = openference_exchange["connection"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(openference_provider_id.starts_with("openference-"));
    assert!(!openference_exchange
        .to_string()
        .contains("openference-browser-refresh"));
    assert_eq!(openference_requests.load(Ordering::SeqCst), 1);

    let refreshed = client
        .post(format!(
            "{second_base}/api/admin/providers/{openference_provider_id}/oauth/refresh"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(refreshed.status(), StatusCode::OK);
    let refreshed: serde_json::Value = refreshed.json().await.unwrap();
    assert_eq!(refreshed["refresh"]["ok"], true);
    assert_eq!(refreshed["refresh"]["generation"], "1");
    assert_eq!(openference_requests.load(Ordering::SeqCst), 2);

    let combo = client
        .put(format!(
            "{second_base}/api/admin/combos/openference-fixture"
        ))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "protocol":"openai",
            "strategy":"priority",
            "fallback":false,
            "targets":[{"provider_id":openference_provider_id,"model":"Qwen3.8 27b"}],
            "enabled":true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(combo.status(), StatusCode::OK);
    let inference = chat_model(&client, &second_base, CLIENT_KEY, "openference-fixture").await;
    assert_eq!(inference.status(), StatusCode::OK);

    let providers = database.providers().await.unwrap();
    assert_eq!(providers.len(), 5);
    let oauth = database.provider_oauth().await.unwrap();
    assert_eq!(oauth.len(), 5);
    assert!(oauth
        .iter()
        .all(|record| record.refresh_token_ciphertext.starts_with("rr:v1:")));
    assert!(oauth
        .iter()
        .all(|record| !record.refresh_token_ciphertext.contains("browser-refresh")));
    let sessions = database.provider_sessions().await.unwrap();
    assert_eq!(sessions.len(), 3);
    assert!(sessions
        .iter()
        .all(|record| record.session_ciphertext.starts_with("rr:v1:")));
    assert!(sessions.iter().all(|record| {
        !record.session_ciphertext.contains("browser-codex")
            && !record.session_ciphertext.contains("user:inference")
    }));

    let unauthorized_export = client
        .post(format!(
            "{second_base}/api/providers/{codex_provider_id}/codex-auth/export"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized_export.status(), StatusCode::UNAUTHORIZED);

    let codex_export = client
        .post(format!(
            "{second_base}/api/providers/{codex_provider_id}/codex-auth/export"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(codex_export.status(), StatusCode::OK);
    assert_eq!(
        codex_export.headers()[header::CACHE_CONTROL],
        HeaderValue::from_static("no-store, max-age=0")
    );
    assert_eq!(
        codex_export.headers()[header::CONTENT_DISPOSITION],
        HeaderValue::from_static("attachment; filename=\"auth-browser-codex@example.com.json\"")
    );
    let codex_export: serde_json::Value =
        serde_json::from_str(&codex_export.text().await.unwrap()).unwrap();
    assert_eq!(codex_export["auth_mode"], "chatgpt");
    assert_eq!(
        codex_export["tokens"]["account_id"],
        "browser-codex-workspace"
    );
    assert_eq!(
        codex_export["tokens"]["refresh_token"],
        "codex-browser-refresh"
    );
    assert!(codex_export["tokens"]["id_token"]
        .as_str()
        .unwrap()
        .contains('.'));

    let codex_refresh = client
        .post(format!(
            "{second_base}/api/providers/{codex_provider_id}/refresh"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(codex_refresh.status(), StatusCode::OK);
    let codex_refresh: serde_json::Value =
        serde_json::from_str(&codex_refresh.text().await.unwrap()).unwrap();
    assert_eq!(codex_refresh["success"], true);
    assert_eq!(codex_refresh["skipped"], true);
    assert_eq!(codex_refresh["provider"], "codex");
    assert_eq!(codex_requests.load(Ordering::SeqCst), 1);

    let claude_export = client
        .post(format!(
            "{second_base}/api/providers/{claude_provider_id}/claude-auth/export"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(claude_export.status(), StatusCode::OK);
    assert_eq!(
        claude_export.headers()[header::CONTENT_DISPOSITION],
        HeaderValue::from_static(
            "attachment; filename=\"claude-auth-browser-claude@example.com.json\""
        )
    );
    let claude_export: serde_json::Value =
        serde_json::from_str(&claude_export.text().await.unwrap()).unwrap();
    assert_eq!(
        claude_export["claudeAiOauth"]["accessToken"],
        "claude-access-browser"
    );
    assert_eq!(
        claude_export["claudeAiOauth"]["scopes"],
        serde_json::json!(["user:inference", "user:profile"])
    );
    assert_eq!(claude_export["claudeAiOauth"]["subscriptionType"], "pro");
    assert_eq!(claude_export["claudeAiOauth"]["rateLimitTier"], "tier-2");

    let wrong_export = client
        .post(format!(
            "{second_base}/api/providers/{codex_provider_id}/claude-auth/export"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_export.status(), StatusCode::BAD_REQUEST);

    first_task.abort();
    second_task.abort();
    oauth_task.abort();
}

#[tokio::test]
async fn rust_imports_claude_cli_auth_with_bounded_bootstrap_identity() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("claude-import.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let (token_endpoint, _, _, _, token_task) = claude_oauth_refresh_server().await;
    let control = ControlPlane::new_with_oauth_refresh_endpoints(
        database.clone(),
        ADMIN_KEY,
        STORAGE_KEY,
        false,
        token_endpoint.clone(),
        token_endpoint,
    )
    .await
    .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let expiry_ms = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3_600)
        * 1_000;
    let auth_file = serde_json::json!({
        "claudeAiOauth":{
            "accessToken":"claude-access-one",
            "refreshToken":"claude-refresh-one",
            "expiresAt":expiry_ms,
            "scopes":["user:inference","user:profile"]
        }
    });
    let imported = client
        .post(format!("{base}/api/providers/claude-auth/import"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "source":{"kind":"text","text":auth_file.to_string()},
                "name":"Primary Claude"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(imported.status(), StatusCode::OK);
    assert_eq!(
        imported.headers()[header::CACHE_CONTROL],
        HeaderValue::from_static("no-store")
    );
    let imported: serde_json::Value =
        serde_json::from_str(&imported.text().await.unwrap()).unwrap();
    assert_eq!(imported["created"], true);
    assert_eq!(imported["connection"]["provider"], "claude");
    assert_eq!(imported["connection"]["label"], "Primary Claude");
    assert_eq!(
        imported["connection"]["account_email"],
        "claude-one@example.com"
    );
    assert!(!imported.to_string().contains("claude-access-one"));
    assert!(!imported.to_string().contains("claude-refresh-one"));
    let provider_id = imported["connection"]["id"].as_str().unwrap().to_owned();

    let duplicate = client
        .post(format!("{base}/api/providers/claude-auth/import"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(serde_json::json!({"source":{"kind":"json","json":auth_file.clone()}}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    let duplicate: serde_json::Value =
        serde_json::from_str(&duplicate.text().await.unwrap()).unwrap();
    assert_eq!(duplicate["code"], "duplicate_account");

    let second = serde_json::json!({
        "claudeAiOauth":{
            "accessToken":"claude-access-two",
            "refreshToken":"claude-refresh-two",
            "expiresAt":expiry_ms.to_string()
        }
    });
    let bulk = client
        .post(format!("{base}/api/providers/claude-auth/import-bulk"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "entries":[
                    {"json":second,"name":"Second Claude"},
                    {"json":{"claudeAiOauth":{}},"name":"Broken"}
                ]
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(bulk.status(), StatusCode::OK);
    let bulk: serde_json::Value = serde_json::from_str(&bulk.text().await.unwrap()).unwrap();
    assert_eq!(bulk["success"], 1);
    assert_eq!(bulk["failed"], 1);
    assert_eq!(bulk["errors"][0]["index"], 1);

    let unverified = serde_json::json!({
        "claudeAiOauth":{
            "accessToken":"claude-access-unverified",
            "refreshToken":"claude-refresh-unverified",
            "expiresAt":expiry_ms
        }
    });
    let rejected = client
        .post(format!("{base}/api/providers/claude-auth/import"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(serde_json::json!({"source":{"kind":"json","json":unverified}}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::CONFLICT);
    let rejected: serde_json::Value =
        serde_json::from_str(&rejected.text().await.unwrap()).unwrap();
    assert_eq!(rejected["code"], "identity_unverified");

    let providers = database.providers().await.unwrap();
    assert_eq!(providers.len(), 2);
    assert!(providers
        .iter()
        .all(|provider| provider.provider == "claude"));
    let oauth = database.provider_oauth().await.unwrap();
    assert_eq!(oauth.len(), 2);
    assert!(oauth
        .iter()
        .all(|record| record.refresh_token_ciphertext.starts_with("rr:v1:")));
    assert!(oauth
        .iter()
        .all(|record| !record.refresh_token_ciphertext.contains("claude-refresh")));
    let audit = client
        .get(format!(
            "{base}/api/admin/audit-log?action=provider.credentials.imported&target={provider_id}"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(audit.status(), StatusCode::OK);
    let audit: serde_json::Value = serde_json::from_str(&audit.text().await.unwrap()).unwrap();
    assert_eq!(audit.as_array().unwrap().len(), 1);
    assert!(!audit.to_string().contains("claude-refresh"));

    gateway_task.abort();
    token_task.abort();
}

#[tokio::test]
async fn rust_imports_refreshes_and_serves_agy_cli_sessions_without_nextjs() {
    use axum::extract::Request;

    let observations = Arc::new(Mutex::new(Vec::<String>::new()));
    let app = Router::new()
        .route(
            "/token",
            post({
                let observations = observations.clone();
                move |body: String| {
                    let observations = observations.clone();
                    async move {
                        let form = url::form_urlencoded::parse(body.as_bytes())
                            .into_owned()
                            .collect::<std::collections::HashMap<_, _>>();
                        assert_eq!(form.get("grant_type").map(String::as_str), Some("refresh_token"));
                        assert_eq!(form.get("client_id").map(String::as_str), Some("test-antigravity-client"));
                        assert_eq!(form.get("client_secret").map(String::as_str), Some("test-antigravity-secret"));
                        assert_eq!(form.get("refresh_token").map(String::as_str), Some("agy-refresh-initial"));
                        observations.lock().unwrap().push("refresh".to_owned());
                        Json(serde_json::json!({
                            "access_token":"agy-access-rotated",
                            "expires_in":3600
                        }))
                    }
                }
            }),
        )
        .route(
            "/userinfo",
            get(|headers: HeaderMap| async move {
                assert_eq!(headers[header::AUTHORIZATION], "Bearer agy-access-initial");
                Json(serde_json::json!({"email":"agy@example.com"}))
            }),
        )
        .route(
            "/load-code-assist",
            post(|headers: HeaderMap, body: String| async move {
                assert_eq!(headers[header::AUTHORIZATION], "Bearer agy-access-initial");
                assert!(headers[header::USER_AGENT]
                    .to_str()
                    .unwrap()
                    .starts_with("antigravity/cli/"));
                let body: serde_json::Value = serde_json::from_str(&body).unwrap();
                assert_eq!(body["metadata"]["ideType"], 9);
                assert_eq!(body["metadata"]["pluginType"], 2);
                Json(serde_json::json!({
                    "cloudaicompanionProject":{"id":"agy-project-1"}
                }))
            }),
        )
        .route(
            "/agy-quota",
            post({
                let observations = observations.clone();
                move |headers: HeaderMap, body: String| {
                    let observations = observations.clone();
                    async move {
                        assert_eq!(headers[header::AUTHORIZATION], "Bearer agy-access-initial");
                        assert_eq!(headers["x-goog-user-project"], "agy-project-1");
                        assert!(headers[header::USER_AGENT]
                            .to_str()
                            .unwrap()
                            .starts_with("antigravity/cli/"));
                        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
                        assert_eq!(body["project"], "agy-project-1");
                        observations.lock().unwrap().push("quota".to_owned());
                        Json(serde_json::json!({"buckets":[
                            {"modelId":"gemini-3.1-pro","remainingFraction":0.75,"resetTime":"2099-09-10T14:00:00Z"},
                            {"modelId":"gemini-3.1-flash","remainingFraction":0.25,"resetTime":"2099-09-10T13:00:00Z"}
                        ]}))
                    }
                }
            }),
        )
        .route(
            "/agy-quota-summary",
            post({
                let observations = observations.clone();
                move |headers: HeaderMap, body: String| {
                    let observations = observations.clone();
                    async move {
                        assert_eq!(headers[header::AUTHORIZATION], "Bearer agy-access-initial");
                        assert_eq!(headers["x-goog-user-project"], "agy-project-1");
                        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
                        assert_eq!(body["project"], "agy-project-1");
                        observations
                            .lock()
                            .unwrap()
                            .push("quota-summary".to_owned());
                        Json(serde_json::json!({"quotaSummary":{"groups":[
                            {"displayName":"Gemini Models","buckets":[
                                {"bucketId":"gemini-weekly","displayName":"Weekly","remainingFraction":0.6,"resetTime":"2099-09-16T13:00:00Z"}
                            ]},
                            {"displayName":"Claude and GPT models","buckets":[
                                {"bucketId":"claude-gpt-weekly","remainingFraction":0.4,"resetTime":"2099-09-16T12:00:00Z"}
                            ]}
                        ]}}))
                    }
                }
            }),
        )
        .route(
            "/v1internal:streamGenerateContent",
            post({
                let observations = observations.clone();
                move |request: Request| {
                    let observations = observations.clone();
                    async move {
                        assert_eq!(
                            request.headers()[header::AUTHORIZATION],
                            "Bearer agy-access-rotated"
                        );
                        assert_eq!(request.headers()["x-goog-user-project"], "agy-project-1");
                        assert_eq!(request.uri().query(), Some("alt=sse"));
                        let body = axum::body::to_bytes(request.into_body(), 16 * 1024)
                            .await
                            .unwrap();
                        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                        assert_eq!(body["project"], "agy-project-1");
                        let translated = body.get("requestId").is_some();
                        if translated {
                            assert_eq!(body["model"], "gemini-2.5-pro");
                        }
                        let first_text = body["request"]["contents"][0]["parts"][0]["text"]
                            .as_str()
                            .unwrap_or_default();
                        let is_tool_follow_up = body["request"]["contents"]
                            .as_array()
                            .is_some_and(|contents| {
                                contents.iter().any(|content| {
                                    content["parts"].as_array().is_some_and(|parts| {
                                        parts.iter().any(|part| {
                                            part.get("functionCall").is_some()
                                                && part["thoughtSignature"]
                                                    == "opaque-agy-thought-signature"
                                        })
                                    })
                                })
                            });
                        observations.lock().unwrap().push("inference".to_owned());
                        let event = if is_tool_follow_up {
                            "data: {\"response\":{\"responseId\":\"agy-tool-finished\",\"modelVersion\":\"gemini-2.5-pro\",\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"weather is sunny\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":8,\"candidatesTokenCount\":2,\"totalTokenCount\":10}}}\n\n"
                        } else if translated && first_text == "use weather" {
                            "data: {\"response\":{\"responseId\":\"agy-tool-response\",\"modelVersion\":\"gemini-2.5-pro\",\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"thoughtSignature\":\"opaque-agy-thought-signature\",\"functionCall\":{\"name\":\"weather\",\"args\":{\"city\":\"SP\"}}}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":4,\"candidatesTokenCount\":3,\"totalTokenCount\":7}}}\n\n"
                        } else {
                            "data: {\"response\":{\"responseId\":\"agy-response-1\",\"modelVersion\":\"gemini-2.5-pro\",\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"hello from Antigravity\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":4,\"candidatesTokenCount\":3,\"totalTokenCount\":7}}}\n\n"
                        };
                        (
                            [(header::CONTENT_TYPE, "text/event-stream")],
                            event,
                        )
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let token_endpoint = Url::parse(&format!("http://{address}/token")).unwrap();
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("agy-import.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new_with_oauth_refresh_endpoints(
        database.clone(),
        ADMIN_KEY,
        STORAGE_KEY,
        false,
        token_endpoint.clone(),
        token_endpoint,
    )
    .await
    .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    let imported = client
        .post(format!("{base}/api/providers/agy-auth/import"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "source":{"kind":"json","json":{"token":{
                "access_token":"agy-access-initial",
                "refresh_token":"agy-refresh-initial",
                "token_type":"Bearer",
                "expiry_date":expires * 1000
            },"auth_method":"consumer"}},
            "name":"Antigravity work account"
        }))
        .send()
        .await
        .unwrap();
    if imported.status() != StatusCode::OK {
        panic!("{}", imported.text().await.unwrap());
    }
    let imported: serde_json::Value = imported.json().await.unwrap();
    let provider_id = imported["connection"]["id"].as_str().unwrap();
    assert_eq!(imported["connection"]["provider"], "agy");
    assert_eq!(imported["connection"]["account_email"], "agy@example.com");
    assert_eq!(imported["connection"]["credential_type"], "oauth");
    assert!(!imported.to_string().contains("agy-access"));
    assert!(!imported.to_string().contains("agy-refresh"));
    let sessions = database.provider_sessions().await.unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].provider, "agy");
    assert!(!sessions[0].session_ciphertext.contains("agy-project-1"));
    let quota = client
        .post(format!(
            "{base}/api/admin/provider-quotas/{provider_id}/refresh"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(quota.status(), StatusCode::OK);
    let quota: serde_json::Value = quota.json().await.unwrap();
    assert_eq!(quota["refresh"]["refreshed"], true);
    assert_eq!(
        quota["refresh"]["quota"]["session"]["remaining_percent"],
        25.0
    );
    assert_eq!(
        quota["refresh"]["quota"]["weekly"]["remaining_percent"],
        40.0
    );
    assert_eq!(
        quota["refresh"]["quota"]["models"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        quota["refresh"]["quota"]["models"][0]["model_id"],
        "gemini-3.1-pro"
    );
    assert_eq!(
        quota["refresh"]["quota"]["models"][0]["session"]["remaining_percent"],
        75.0
    );
    assert_eq!(database.provider_model_quotas().await.unwrap().len(), 2);
    assert!(!quota.to_string().contains("agy-access"));
    assert!(observations.lock().unwrap().contains(&"quota".to_owned()));
    assert!(observations
        .lock()
        .unwrap()
        .contains(&"quota-summary".to_owned()));
    let refreshed = client
        .post(format!("{base}/api/providers/{provider_id}/refresh"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(refreshed.status(), StatusCode::OK);
    let refreshed: serde_json::Value = refreshed.json().await.unwrap();
    assert_eq!(refreshed["success"], true);
    let combo = client
        .put(format!("{base}/api/admin/combos/agy-route"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "protocol":"antigravity",
            "strategy":"priority",
            "fallback":true,
            "targets":[{"provider_id":provider_id,"model":"gemini-2.5-pro"}],
            "enabled":true
        }))
        .send()
        .await
        .unwrap();
    if combo.status() != StatusCode::OK {
        panic!("{}", combo.text().await.unwrap());
    }
    let inference = client
        .post(format!("{base}/v1/antigravity"))
        .bearer_auth(CLIENT_KEY)
        .json(&serde_json::json!({
            "model":"agy-route",
            "project":"client-controlled-project",
            "request":{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(inference.status(), StatusCode::OK);
    assert!(inference.text().await.unwrap().contains("finishReason"));
    let translated_combo = client
        .put(format!("{base}/api/admin/combos/agy-openai"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "protocol":"openai-to-antigravity",
            "strategy":"priority",
            "fallback":true,
            "targets":[{"provider_id":provider_id,"model":"gemini-2.5-pro"}],
            "enabled":true
        }))
        .send()
        .await
        .unwrap();
    if translated_combo.status() != StatusCode::OK {
        panic!("{}", translated_combo.text().await.unwrap());
    }
    let translated = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(CLIENT_KEY)
        .json(&serde_json::json!({
            "model":"agy-openai",
            "messages":[{"role":"user","content":"hello from OpenAI"}],
            "stream":false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(translated.status(), StatusCode::OK);
    let translated: serde_json::Value = translated.json().await.unwrap();
    assert_eq!(
        translated["choices"][0]["message"]["content"],
        "hello from Antigravity"
    );
    assert_eq!(translated["usage"]["total_tokens"], 7);
    let tool_turn = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(CLIENT_KEY)
        .json(&serde_json::json!({
            "model":"agy-openai",
            "messages":[{"role":"user","content":"use weather"}],
            "tools":[{"type":"function","function":{"name":"weather","parameters":{"type":"object"}}}],
            "stream":false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(tool_turn.status(), StatusCode::OK);
    let tool_turn: serde_json::Value = tool_turn.json().await.unwrap();
    let tool_call = tool_turn["choices"][0]["message"]["tool_calls"][0].clone();
    assert!(tool_call["id"].as_str().unwrap().starts_with("call_agy_"));
    assert!(!tool_turn
        .to_string()
        .contains("opaque-agy-thought-signature"));
    let follow_up = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(CLIENT_KEY)
        .json(&serde_json::json!({
            "model":"agy-openai",
            "messages":[
                {"role":"user","content":"use weather"},
                {"role":"assistant","content":null,"tool_calls":[tool_call.clone()]},
                {"role":"tool","tool_call_id":tool_call["id"],"content":"sunny"}
            ],
            "tools":[{"type":"function","function":{"name":"weather","parameters":{"type":"object"}}}],
            "stream":false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(follow_up.status(), StatusCode::OK);
    let follow_up: serde_json::Value = follow_up.json().await.unwrap();
    assert_eq!(
        follow_up["choices"][0]["message"]["content"],
        "weather is sunny"
    );
    assert_eq!(
        observations.lock().unwrap().as_slice(),
        [
            "quota",
            "quota-summary",
            "refresh",
            "inference",
            "inference",
            "inference",
            "inference"
        ]
    );
    gateway_task.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn rust_oauth_credentials_are_redacted_and_rotate_with_sqlite_cas() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("provider-oauth.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let (token_endpoint, _token_requests, _token_mode, _refresh_tokens, token_task) =
        claude_oauth_refresh_server().await;
    let control = ControlPlane::new_with_oauth_refresh_endpoints(
        database.clone(),
        ADMIN_KEY,
        STORAGE_KEY,
        false,
        token_endpoint.clone(),
        token_endpoint,
    )
    .await
    .unwrap();
    let (upstream, requests, provider_task) = recording_anthropic_bearer_provider().await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3_600;

    let unverified = client
        .put(format!("{base}/api/admin/providers/claude-unverified"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "provider":"claude",
                "upstream_url":&upstream,
                "api_key":"claude-access-unverified",
                "auth_scheme":"bearer",
                "expires_at_unix":expiry,
                "credential_type":"oauth",
                "oauth_provider":"claude",
                "refresh_token":"unverified-refresh-token"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(unverified.status(), StatusCode::BAD_REQUEST);
    assert!(database.providers().await.unwrap().is_empty());
    assert!(database.provider_oauth().await.unwrap().is_empty());
    assert!(database.provider_sessions().await.unwrap().is_empty());

    let configured = client
        .put(format!("{base}/api/admin/providers/claude-oauth"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "provider":"claude",
                "upstream_url":&upstream,
                "api_key":"claude-access-one",
                "auth_scheme":"bearer",
                "expires_at_unix":expiry,
                "credential_type":"oauth",
                "oauth_provider":"claude",
                "refresh_token":"initial-oauth-refresh-token"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(configured.status(), StatusCode::OK);
    let configured: serde_json::Value =
        serde_json::from_str(&configured.text().await.unwrap()).unwrap();
    assert_eq!(configured["provider"]["credential_type"], "oauth");
    assert_eq!(configured["provider"]["oauth_provider"], "claude");
    assert_eq!(configured["provider"]["oauth_generation"], "0");
    assert_eq!(configured["provider"]["refreshable"], true);
    assert!(!configured.to_string().contains("initial-oauth"));

    let oauth = database.provider_oauth().await.unwrap();
    assert_eq!(oauth.len(), 1);
    assert_eq!(oauth[0].generation, 0);
    assert!(oauth[0].refresh_token_ciphertext.starts_with("rr:v1:"));
    assert!(!oauth[0]
        .refresh_token_ciphertext
        .contains("initial-oauth-refresh-token"));

    let metadata_only_update = client
        .put(format!("{base}/api/admin/providers/claude-oauth"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "provider":"claude",
                "upstream_url":&upstream,
                "auth_scheme":"bearer",
                "label":"Renamed Claude account",
                "expires_at_unix":expiry,
                "credential_type":"oauth",
                "oauth_provider":"claude"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(metadata_only_update.status(), StatusCode::OK);
    let metadata_only_update: serde_json::Value = metadata_only_update.json().await.unwrap();
    assert_eq!(
        metadata_only_update["provider"]["label"],
        "Renamed Claude account"
    );
    assert_eq!(metadata_only_update["provider"]["oauth_generation"], "0");
    assert!(!metadata_only_update.to_string().contains("initial-oauth"));
    let preserved_oauth = database.provider_oauth().await.unwrap();
    assert_eq!(preserved_oauth.len(), 1);
    assert_eq!(preserved_oauth[0].generation, 0);
    assert_eq!(
        preserved_oauth[0].refresh_token_ciphertext,
        oauth[0].refresh_token_ciphertext
    );

    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/claude-oauth-fixture"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "protocol":"anthropic",
                    "strategy":"priority",
                    "targets":[{"provider_id":"claude-oauth","model":"claude-oauth-fixture"}]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .post(format!("{base}/v1/messages"))
            .bearer_auth(CLIENT_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "model":"claude-oauth-fixture",
                    "messages":[],
                    "max_tokens":8
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let rotated = client
        .post(format!(
            "{base}/api/admin/providers/claude-oauth/oauth/rotate"
        ))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "expected_generation":"0",
                "access_token":"rotated-oauth-access-token",
                "refresh_token":"rotated-oauth-refresh-token",
                "expires_at_unix":expiry + 3_600
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(rotated.status(), StatusCode::OK);
    let rotated: serde_json::Value = serde_json::from_str(&rotated.text().await.unwrap()).unwrap();
    assert_eq!(rotated["provider"]["oauth_generation"], "1");
    assert!(!rotated.to_string().contains("rotated-oauth"));
    let oauth_audit = client
        .get(format!(
            "{base}/api/admin/audit-log?action=provider_oauth.rotate&target=claude-oauth"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(oauth_audit.status(), StatusCode::OK);
    let oauth_audit: serde_json::Value =
        serde_json::from_str(&oauth_audit.text().await.unwrap()).unwrap();
    assert_eq!(oauth_audit.as_array().unwrap().len(), 1);
    assert_eq!(oauth_audit[0]["details"]["before"]["generation"], "0");
    assert_eq!(oauth_audit[0]["details"]["after"]["generation"], "1");
    let oauth_audit_details = oauth_audit[0]["details"].to_string();
    assert!(!oauth_audit_details.contains("rotated-oauth-access-token"));
    assert!(!oauth_audit_details.contains("rotated-oauth-refresh-token"));

    let stale = client
        .post(format!(
            "{base}/api/admin/providers/claude-oauth/oauth/rotate"
        ))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "expected_generation":"0",
                "access_token":"stale-access-token",
                "refresh_token":"stale-refresh-token",
                "expires_at_unix":expiry + 7_200
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);

    assert_eq!(
        client
            .post(format!("{base}/v1/messages"))
            .bearer_auth(CLIENT_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "model":"claude-oauth-fixture",
                    "messages":[],
                    "max_tokens":8
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        requests.lock().unwrap().as_slice(),
        [
            "Bearer claude-access-one",
            "Bearer rotated-oauth-access-token"
        ]
    );
    let oauth = database.provider_oauth().await.unwrap();
    assert_eq!(oauth[0].generation, 1);
    assert!(!oauth[0]
        .refresh_token_ciphertext
        .contains("rotated-oauth-refresh-token"));

    gateway_task.abort();
    provider_task.abort();
    token_task.abort();
}

#[tokio::test]
async fn rust_refreshes_and_routes_imported_github_copilot_oauth() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("github-copilot.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let (token_endpoint, upstream, refreshes, inference, fixture_task) =
        github_copilot_fixture().await;
    let control = ControlPlane::new_with_oauth_refresh_endpoints(
        database,
        ADMIN_KEY,
        STORAGE_KEY,
        true,
        token_endpoint.clone(),
        token_endpoint,
    )
    .await
    .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;

    let configured = client
        .put(format!("{base}/api/admin/providers/github-copilot"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "provider":"github",
                "upstream_url":upstream,
                "api_key":"initial-copilot-token",
                "auth_scheme":"bearer",
                "expires_at_unix":expiry,
                "credential_type":"oauth",
                "oauth_provider":"github",
                "refresh_token":"github-long-lived-token"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(configured.status(), StatusCode::OK);
    let configured: serde_json::Value = configured.json().await.unwrap();
    assert_eq!(configured["provider"]["oauth_provider"], "github");
    assert_eq!(configured["provider"]["refreshable"], true);
    assert!(!configured.to_string().contains("github-long-lived-token"));

    let refreshed = client
        .post(format!(
            "{base}/api/admin/providers/github-copilot/oauth/refresh"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(refreshed.status(), StatusCode::OK);
    let refreshed: serde_json::Value = refreshed.json().await.unwrap();
    assert_eq!(refreshed["refresh"]["category"], "refreshed");
    assert_eq!(refreshed["refresh"]["generation"], "1");
    assert_eq!(refreshes.load(Ordering::SeqCst), 1);

    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/github-copilot-fixture"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "protocol":"openai",
                    "strategy":"priority",
                    "targets":[{"provider_id":"github-copilot","model":"gpt-5.4"}]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let response = chat_model(&client, &base, CLIENT_KEY, "github-copilot-fixture").await;
    let response_status = response.status();
    let response_body = response.text().await.unwrap();
    assert_eq!(response_status, StatusCode::OK, "{response_body}");
    assert_eq!(inference.load(Ordering::SeqCst), 1);

    gateway_task.abort();
    fixture_task.abort();
}

#[tokio::test]
async fn rust_refreshes_and_routes_imported_xai_oauth() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("xai-oauth.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let (token_endpoint, upstream, refreshes, inference, fixture_task) = xai_oauth_fixture().await;
    let control = ControlPlane::new_with_oauth_refresh_endpoints(
        database,
        ADMIN_KEY,
        STORAGE_KEY,
        true,
        token_endpoint.clone(),
        token_endpoint,
    )
    .await
    .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;

    let configured = client
        .put(format!("{base}/api/admin/providers/xai-oauth"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "provider":"xai-oauth",
                "upstream_url":upstream,
                "api_key":"xai-initial-access-token",
                "auth_scheme":"bearer",
                "expires_at_unix":expiry,
                "credential_type":"oauth",
                "oauth_provider":"xai-oauth",
                "refresh_token":"xai-refresh-token"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(configured.status(), StatusCode::OK);
    let configured: serde_json::Value = configured.json().await.unwrap();
    assert_eq!(configured["provider"]["oauth_provider"], "xai-oauth");
    assert_eq!(configured["provider"]["refreshable"], true);
    assert!(!configured.to_string().contains("xai-refresh-token"));

    let refreshed = client
        .post(format!(
            "{base}/api/admin/providers/xai-oauth/oauth/refresh"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(refreshed.status(), StatusCode::OK);
    let refreshed: serde_json::Value = refreshed.json().await.unwrap();
    assert_eq!(refreshed["refresh"]["category"], "refreshed");
    assert_eq!(refreshed["refresh"]["generation"], "1");
    assert_eq!(refreshes.load(Ordering::SeqCst), 1);

    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/xai-oauth-fixture"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "protocol":"openai",
                    "strategy":"priority",
                    "targets":[{"provider_id":"xai-oauth","model":"grok-4.3"}]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let response = chat_model(&client, &base, CLIENT_KEY, "xai-oauth-fixture").await;
    let response_status = response.status();
    let response_body = response.text().await.unwrap();
    assert_eq!(response_status, StatusCode::OK, "{response_body}");
    assert_eq!(inference.load(Ordering::SeqCst), 1);

    gateway_task.abort();
    fixture_task.abort();
}

#[tokio::test]
async fn rust_oauth_refresh_is_leased_across_replicas_and_persists_terminal_state() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("provider-refresh.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let (token_endpoint, token_requests, token_mode, observed_refresh_tokens, token_task) =
        claude_oauth_refresh_server().await;
    let (upstream, upstream_requests, provider_task) = recording_anthropic_bearer_provider().await;
    let first = ControlPlane::new_with_oauth_refresh_endpoints(
        database.clone(),
        ADMIN_KEY,
        STORAGE_KEY,
        false,
        token_endpoint.clone(),
        token_endpoint.clone(),
    )
    .await
    .unwrap();
    let (first_base, first_task) = gateway(first).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3_600;
    assert_eq!(
        client
            .put(format!("{first_base}/api/admin/providers/claude-refresh"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "provider":"claude",
                    "upstream_url":&upstream,
                    "api_key":"claude-access-one",
                    "auth_scheme":"bearer",
                    "expires_at_unix":expiry,
                    "credential_type":"oauth",
                    "oauth_provider":"claude",
                    "refresh_token":"initial-refresh-token"
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!(
                "{first_base}/api/admin/combos/claude-refresh-model"
            ))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "protocol":"anthropic",
                    "strategy":"priority",
                    "targets":[{"provider_id":"claude-refresh","model":"claude-refresh-model"}]
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    let second_database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let second = ControlPlane::new_with_oauth_refresh_endpoints(
        second_database,
        ADMIN_KEY,
        STORAGE_KEY,
        false,
        token_endpoint.clone(),
        token_endpoint,
    )
    .await
    .unwrap();
    let (second_base, second_task) = gateway(second).await;
    let first_refresh = client
        .post(format!(
            "{first_base}/api/admin/providers/claude-refresh/oauth/refresh"
        ))
        .bearer_auth(ADMIN_KEY)
        .send();
    let second_refresh = client
        .post(format!(
            "{second_base}/api/admin/providers/claude-refresh/oauth/refresh"
        ))
        .bearer_auth(ADMIN_KEY)
        .send();
    let (first_refresh, second_refresh) = tokio::join!(first_refresh, second_refresh);
    async fn refresh_json(
        client: &reqwest::Client,
        base: &str,
        response: reqwest::Response,
    ) -> serde_json::Value {
        let response = if response.status() == StatusCode::SERVICE_UNAVAILABLE {
            // A concurrent SQLite writer may make the first lease attempt fail
            // closed. Retrying after the winning request commits must observe
            // the settling lease instead of performing a second token refresh.
            tokio::time::sleep(Duration::from_millis(100)).await;
            client
                .post(format!(
                    "{base}/api/admin/providers/claude-refresh/oauth/refresh"
                ))
                .bearer_auth(ADMIN_KEY)
                .send()
                .await
                .unwrap()
        } else {
            response
        };
        let status = response.status();
        let body = response.text().await.unwrap();
        assert_eq!(status, StatusCode::OK, "{body}");
        serde_json::from_str(&body).unwrap()
    }
    let first_refresh = refresh_json(&client, &first_base, first_refresh.unwrap()).await;
    let second_refresh = refresh_json(&client, &second_base, second_refresh.unwrap()).await;
    let categories = [
        first_refresh["refresh"]["category"].as_str().unwrap(),
        second_refresh["refresh"]["category"].as_str().unwrap(),
    ];
    assert!(
        categories.contains(&"refreshed"),
        "refresh categories={categories:?}; token requests={}; durable generation={:?}",
        token_requests.load(Ordering::SeqCst),
        database
            .provider_oauth()
            .await
            .unwrap()
            .iter()
            .map(|row| row.generation)
            .collect::<Vec<_>>()
    );
    assert!(categories.contains(&"refresh_in_progress"));
    assert_eq!(token_requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        observed_refresh_tokens.lock().unwrap().as_slice(),
        ["initial-refresh-token"]
    );
    assert_eq!(database.provider_oauth().await.unwrap()[0].generation, 1);
    let refresh_audit = client
        .get(format!(
            "{first_base}/api/admin/audit-log?action=provider_oauth.refresh&target=claude-refresh"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(refresh_audit.status(), StatusCode::OK);
    let refresh_audit: serde_json::Value =
        serde_json::from_str(&refresh_audit.text().await.unwrap()).unwrap();
    assert_eq!(refresh_audit.as_array().unwrap().len(), 2);
    assert!(refresh_audit
        .as_array()
        .unwrap()
        .iter()
        .any(|event| { event["details"]["after"]["category"] == "refreshed" }));
    assert!(refresh_audit
        .as_array()
        .unwrap()
        .iter()
        .any(|event| { event["details"]["after"]["category"] == "refresh_in_progress" }));
    assert!(!refresh_audit.to_string().contains("initial-refresh-token"));
    assert!(!refresh_audit.to_string().contains("server-refreshed"));

    let refreshed_base = if first_refresh["refresh"]["category"] == "refreshed" {
        &first_base
    } else {
        &second_base
    };
    assert_eq!(
        client
            .post(format!("{refreshed_base}/v1/messages"))
            .bearer_auth(CLIENT_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "model":"claude-refresh-model",
                    "messages":[],
                    "max_tokens":8
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        upstream_requests.lock().unwrap().last().map(String::as_str),
        Some("Bearer server-refreshed-access-token")
    );

    let follower_base = if first_refresh["refresh"]["category"] == "refreshed" {
        &second_base
    } else {
        &first_base
    };
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let status = client
                .post(format!("{follower_base}/v1/messages"))
                .bearer_auth(CLIENT_KEY)
                .header(header::CONTENT_TYPE.as_str(), "application/json")
                .body(
                    serde_json::json!({
                        "model":"claude-refresh-model",
                        "messages":[],
                        "max_tokens":8
                    })
                    .to_string(),
                )
                .send()
                .await
                .unwrap()
                .status();
            if status == StatusCode::OK
                && upstream_requests.lock().unwrap().last().map(String::as_str)
                    == Some("Bearer server-refreshed-access-token")
            {
                break;
            }
            // Before the follower observes the committed generation it may
            // either serve one request with its still-valid prior snapshot or
            // fail closed while reloading. The convergence condition above is
            // the security property: the loop must eventually publish and use
            // the rotated credential, and no other response class is valid.
            assert!(matches!(
                status,
                StatusCode::OK | StatusCode::SERVICE_UNAVAILABLE
            ));
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("the follower did not publish the rotated provider credential");

    tokio::time::sleep(Duration::from_millis(2_100)).await;
    token_mode.store(1, Ordering::SeqCst);
    assert_eq!(
        client
            .put(format!("{first_base}/api/admin/providers/claude-refresh"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "provider":"claude",
                    "upstream_url":&upstream,
                    "api_key":"claude-access-two",
                    "auth_scheme":"bearer",
                    "expires_at_unix":expiry,
                    "credential_type":"oauth",
                    "oauth_provider":"claude",
                    "refresh_token":"revoked-refresh-token"
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let terminal = client
        .post(format!(
            "{first_base}/api/admin/providers/claude-refresh/oauth/refresh"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    let terminal: serde_json::Value =
        serde_json::from_str(&terminal.text().await.unwrap()).unwrap();
    assert_eq!(terminal["refresh"]["category"], "reauth_required");
    assert_eq!(token_requests.load(Ordering::SeqCst), 2);
    let repeated = client
        .post(format!(
            "{first_base}/api/admin/providers/claude-refresh/oauth/refresh"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    let repeated: serde_json::Value =
        serde_json::from_str(&repeated.text().await.unwrap()).unwrap();
    assert_eq!(repeated["refresh"]["category"], "reauth_required");
    assert_eq!(token_requests.load(Ordering::SeqCst), 2);
    let listed = client
        .get(format!("{first_base}/api/admin/providers"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    let listed: serde_json::Value = serde_json::from_str(&listed.text().await.unwrap()).unwrap();
    assert_eq!(listed["providers"][0]["reauth_required"], true);
    assert_eq!(listed["providers"][0]["oauth_error_code"], "invalid_grant");
    assert!(!listed.to_string().contains("revoked-refresh-token"));

    first_task.abort();
    second_task.abort();
    token_task.abort();
    provider_task.abort();
}

#[tokio::test]
async fn rust_provider_auth_metadata_drives_headers_and_expiry() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("provider-auth.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (upstream, requests, provider_task) = anthropic_bearer_provider("oauth-access-token").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3_600;

    let response = client
        .put(format!("{base}/api/admin/providers/anthropic-oauth"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "provider":"anthropic",
                "upstream_url":upstream,
                "api_key":"oauth-access-token",
                "auth_scheme":"bearer",
                "label":"Claude team account",
                "account_email":"agents@example.com",
                "expires_at_unix":expiry
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response: serde_json::Value =
        serde_json::from_str(&response.text().await.unwrap()).unwrap();
    let provider = &response["provider"];
    assert_eq!(provider["auth_scheme"], "bearer");
    assert_eq!(provider["label"], "Claude team account");
    assert_eq!(provider["account_email"], "agents@example.com");
    assert_eq!(provider["expires_at_unix"], expiry);
    assert_eq!(provider["credential_expired"], false);
    assert!(provider.get("api_key").is_none());

    let combo = client
        .put(format!("{base}/api/admin/combos/claude-fixture"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "protocol":"anthropic",
                "strategy":"priority",
                "targets":[{
                    "provider_id":"anthropic-oauth",
                    "model":"claude-fixture"
                }]
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(combo.status(), StatusCode::OK);

    let diagnostic = client
        .post(format!("{base}/api/admin/providers/anthropic-oauth/test"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(serde_json::json!({"model":"claude-fixture"}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(diagnostic.status(), StatusCode::OK);
    let diagnostic: serde_json::Value =
        serde_json::from_str(&diagnostic.text().await.unwrap()).unwrap();
    assert_eq!(diagnostic["diagnostic"]["provider_id"], "anthropic-oauth");
    assert_eq!(diagnostic["diagnostic"]["model"], "claude-fixture");
    assert_eq!(diagnostic["diagnostic"]["ok"], true);
    assert_eq!(diagnostic["diagnostic"]["category"], "ok");
    assert_eq!(diagnostic["diagnostic"]["upstream_status"], 200);
    assert!(diagnostic.to_string().find("oauth-access-token").is_none());
    assert_eq!(requests.load(Ordering::SeqCst), 1);

    let inference = client
        .post(format!("{base}/v1/messages"))
        .bearer_auth(CLIENT_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "model":"claude-fixture",
                "messages":[],
                "max_tokens":8
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(inference.status(), StatusCode::OK);
    assert_eq!(requests.load(Ordering::SeqCst), 2);

    let mut auth = database.provider_auth().await.unwrap();
    assert_eq!(auth.len(), 1);
    assert_eq!(auth[0].auth_scheme, "bearer");
    assert_eq!(auth[0].label, "Claude team account");
    auth[0].expires_at_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
        - 1;
    database.upsert_provider_auth(&auth[0]).await.unwrap();

    gateway_task.abort();
    let restarted = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    let expired_diagnostic = client
        .post(format!(
            "{restarted_base}/api/admin/providers/anthropic-oauth/test"
        ))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(serde_json::json!({"model":"claude-fixture"}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(expired_diagnostic.status(), StatusCode::OK);
    let expired_diagnostic: serde_json::Value =
        serde_json::from_str(&expired_diagnostic.text().await.unwrap()).unwrap();
    assert_eq!(
        expired_diagnostic["diagnostic"]["category"],
        "credential_expired"
    );
    assert!(expired_diagnostic["diagnostic"]["upstream_status"].is_null());
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    let expired = client
        .post(format!("{restarted_base}/v1/messages"))
        .bearer_auth(CLIENT_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "model":"claude-fixture",
                "messages":[],
                "max_tokens":8
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(expired.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(expired
        .text()
        .await
        .unwrap()
        .contains("credentials expired"));
    assert_eq!(requests.load(Ordering::SeqCst), 2);

    restarted_task.abort();
    provider_task.abort();
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
                "upstream_url":&first_url,
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

    let metadata_only_update = client
        .put(format!("{base}/api/admin/providers/first"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "provider":"openai",
                "upstream_url":first_url,
                "label":"First provider renamed"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(metadata_only_update.status(), StatusCode::OK);
    let metadata_only_update: serde_json::Value = metadata_only_update.json().await.unwrap();
    assert_eq!(
        metadata_only_update["provider"]["label"],
        "First provider renamed"
    );
    assert_eq!(
        chat(&client, &base, CLIENT_KEY).await.text().await.unwrap(),
        "first"
    );

    let unsafe_upstream_change = client
        .put(format!("{base}/api/admin/providers/first"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(
            serde_json::json!({
                "provider":"openai",
                "upstream_url":&second_url,
                "label":"Must not reuse the credential"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(unsafe_upstream_change.status(), StatusCode::BAD_REQUEST);
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
                "model_id_format":"flat",
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
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/invalid-format"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Invalid format",
                    "api_key":"invalid-format-client-key-123456",
                    "model_id_format":"bare"
                })
                .to_string()
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
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
    assert_eq!(stored_keys[0].model_id_format, "flat");
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
    assert!(key_listing.contains("\"model_id_format\":\"flat\""));
    assert!(!key_listing.contains(RUST_CLIENT_KEY));
    assert!(!key_listing.contains("key_hash"));

    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/removable-provider-guard"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "protocol":"openai",
                    "strategy":"priority",
                    "targets":[{"provider_id":"second","model":"fixture-model"}]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    assert_eq!(
        client
            .delete(format!("{base}/api/admin/providers/second/purge"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );

    assert_eq!(
        client
            .delete(format!("{base}/api/admin/providers/second"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        client
            .delete(format!("{base}/api/admin/combos/removable-provider-guard"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        client
            .delete(format!("{base}/api/admin/providers/second"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    let provider_disable_audit = client
        .get(format!(
            "{base}/api/admin/audit-log?action=provider.disable&target=second"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(provider_disable_audit.status(), StatusCode::OK);
    let provider_disable_audit: serde_json::Value =
        serde_json::from_str(&provider_disable_audit.text().await.unwrap()).unwrap();
    assert_eq!(provider_disable_audit.as_array().unwrap().len(), 1);
    assert_eq!(provider_disable_audit[0]["actor"], "bootstrap-admin");
    assert_eq!(
        provider_disable_audit[0]["details"]["after"]["enabled"],
        false
    );
    let provider_disable_details = provider_disable_audit[0]["details"].to_string();
    assert!(!provider_disable_details.contains("second-provider-secret"));
    assert!(!provider_disable_details.contains("upstream_url"));
    assert_eq!(
        client
            .delete(format!("{base}/api/admin/providers/second/purge"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    let provider_delete_audit = client
        .get(format!(
            "{base}/api/admin/audit-log?action=provider.delete&target=second"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(provider_delete_audit.status(), StatusCode::OK);
    let provider_delete_audit: serde_json::Value = provider_delete_audit.json().await.unwrap();
    assert_eq!(provider_delete_audit.as_array().unwrap().len(), 1);
    assert!(provider_delete_audit[0]["details"]["after"].is_null());
    let providers_after_delete: serde_json::Value = client
        .get(format!("{base}/api/admin/providers"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(providers_after_delete["providers"]
        .as_array()
        .unwrap()
        .iter()
        .all(|provider| provider["id"] != "second"));
    assert!(database
        .provider_auth()
        .await
        .unwrap()
        .iter()
        .all(|auth| auth.provider_id != "second"));
    assert!(database
        .provider_resilience()
        .await
        .unwrap()
        .iter()
        .all(|resilience| resilience.provider_id != "second"));
    assert_eq!(
        chat(&client, &base, RUST_CLIENT_KEY).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/removable-provider-guard"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "protocol":"openai",
                    "strategy":"priority",
                    "targets":[{"provider_id":"first","model":"fixture-model"}]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/agent-fleet"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Agent fleet",
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["removable-provider-guard","fixture-model"],
                    "allowed_provider_ids":["first"],
                    "max_concurrent_requests":32,
                    "max_requests_per_minute":600
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
        chat_model(&client, &base, RUST_CLIENT_KEY, "removable-provider-guard",)
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
        chat_model(
            &client,
            &restarted_base,
            RUST_CLIENT_KEY,
            "removable-provider-guard",
        )
        .await
        .text()
        .await
        .unwrap(),
        "first"
    );
    let identity = client
        .get(format!("{restarted_base}/v1/key"))
        .bearer_auth(RUST_CLIENT_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(identity.status(), StatusCode::OK);
    let identity: serde_json::Value =
        serde_json::from_str(&identity.text().await.unwrap()).unwrap();
    assert_eq!(identity["id_format"], "flat");
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
            .delete(format!(
                "{restarted_base}/api/admin/combos/removable-provider-guard"
            ))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
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
async fn rust_owns_dashboard_model_token_limit_crud() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("model-limits.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let key = client
        .put(format!("{base}/api/admin/client-keys/model-budget"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "label":"Model budget","api_key":RUST_CLIENT_KEY,"enabled":false,
            "max_tokens_per_day":1000,"reservation_tokens":60
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(key.status(), StatusCode::OK);
    let created = client
        .post(format!("{base}/api/usage/token-limits"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "apiKeyId":"model-budget","scopeType":"model","scopeValue":"gpt-4.1",
            "tokenLimit":100,"resetInterval":"daily","resetTime":"02:30","enabled":true
        }))
        .send()
        .await
        .unwrap();
    let created_status = created.status();
    let created_body = created.text().await.unwrap();
    assert_eq!(
        created_status,
        StatusCode::OK,
        "model token limit creation failed: {created_body}"
    );
    let created: serde_json::Value = serde_json::from_str(&created_body).unwrap();
    let id = created["limit"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created["limit"]["resetTime"], "02:30");
    let listed = client
        .get(format!(
            "{base}/api/usage/token-limits?apiKeyId=model-budget"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    let listed: serde_json::Value = listed.json().await.unwrap();
    assert_eq!(listed["limits"][0]["scopeValue"], "gpt-4.1");
    let enabled = client
        .put(format!("{base}/api/admin/client-keys/model-budget"))
        .bearer_auth(ADMIN_KEY)
        .json(&serde_json::json!({
            "label":"Model budget","enabled":true,"max_tokens_per_day":1000,"reservation_tokens":101
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(enabled.status(), StatusCode::BAD_REQUEST);
    let deleted = client
        .delete(format!("{base}/api/usage/token-limits?id={id}"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);
    gateway_task.abort();
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
    let quota_clear_audit = client
        .get(format!(
            "{base}/api/admin/audit-log?action=provider_quota.clear&target=quota-second"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(quota_clear_audit.status(), StatusCode::OK);
    let quota_clear_audit: serde_json::Value =
        serde_json::from_str(&quota_clear_audit.text().await.unwrap()).unwrap();
    assert_eq!(quota_clear_audit.as_array().unwrap().len(), 1);
    assert!(quota_clear_audit[0]["details"]["before"].is_object());
    assert!(quota_clear_audit[0]["details"]["after"].is_null());

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

#[tokio::test]
async fn connection_cooldown_falls_back_and_survives_gateway_restart() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("availability.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (limited_url, limited_requests, limited_status, limited_body, limited_task) =
        counted_status_provider("limited-secret", StatusCode::TOO_MANY_REQUESTS, Some("60")).await;
    let (healthy_url, healthy_task) = provider("healthy-secret", "healthy").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    for (id, upstream_url, api_key) in [
        ("limited", limited_url.clone(), "limited-secret"),
        ("healthy", healthy_url.clone(), "healthy-secret"),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/providers/{id}"))
                .bearer_auth(ADMIN_KEY)
                .header(header::CONTENT_TYPE.as_str(), "application/json")
                .body(
                    serde_json::json!({
                        "provider": if id == "limited" { "openai" } else { "openai-compatible" },
                        "upstream_url":upstream_url,
                        "api_key":api_key
                    })
                    .to_string(),
                )
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    // A crash after writing the settings row but before advancing the provider
    // revision must not make the uncommitted policy visible after restart.
    database
        .upsert_provider_resilience(&StoredResilience {
            provider_id: "limited".into(),
            rate_limit_scope: "model".into(),
            revision: i64::MAX,
        })
        .await
        .unwrap();
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/availability-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Availability client",
                    "api_key":RUST_CLIENT_KEY,
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":["availability-combo","upstream-model"],
                    "allowed_provider_ids":["limited","healthy"]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .put(format!("{base}/api/admin/combos/availability-combo"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "strategy":"priority",
                    "fallback":true,
                    "targets":[
                        {"provider_id":"limited","model":"upstream-model"},
                        {"provider_id":"healthy","model":"upstream-model"}
                    ]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );

    for _ in 0..2 {
        let response = chat_model(&client, &base, RUST_CLIENT_KEY, "availability-combo").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "healthy");
    }
    assert_eq!(limited_requests.load(Ordering::SeqCst), 1);
    let health = client
        .get(format!("{base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let health: serde_json::Value = serde_json::from_str(&health).unwrap();
    let limited = health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "limited")
        .unwrap();
    assert_eq!(limited["connection_last_status"], 429);
    assert_eq!(limited["connection_backoff_level"], 1);
    assert!(limited["connection_retry_after_ms"].as_u64().unwrap() > 0);

    gateway_task.abort();
    let restarted = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    assert_eq!(
        chat_model(
            &client,
            &restarted_base,
            RUST_CLIENT_KEY,
            "availability-combo"
        )
        .await
        .text()
        .await
        .unwrap(),
        "healthy"
    );
    assert_eq!(limited_requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        client
            .delete(format!(
                "{restarted_base}/api/admin/provider-health/limited"
            ))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        chat_model(
            &client,
            &restarted_base,
            RUST_CLIENT_KEY,
            "availability-combo"
        )
        .await
        .text()
        .await
        .unwrap(),
        "healthy"
    );
    assert_eq!(limited_requests.load(Ordering::SeqCst), 2);

    limited_status.store(StatusCode::UNAUTHORIZED.as_u16() as usize, Ordering::SeqCst);
    assert_eq!(
        client
            .delete(format!(
                "{restarted_base}/api/admin/provider-health/limited"
            ))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    for _ in 0..2 {
        assert_eq!(
            chat_model(
                &client,
                &restarted_base,
                RUST_CLIENT_KEY,
                "availability-combo"
            )
            .await
            .text()
            .await
            .unwrap(),
            "healthy"
        );
    }
    assert_eq!(limited_requests.load(Ordering::SeqCst), 3);
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
    let limited = health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "limited")
        .unwrap();
    assert_eq!(limited["terminal_status"], "expired");
    assert_eq!(limited["connection_last_status"], 401);

    restarted_task.abort();
    let terminal_restart = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (terminal_base, terminal_task) = gateway(terminal_restart).await;
    assert_eq!(
        chat_model(
            &client,
            &terminal_base,
            RUST_CLIENT_KEY,
            "availability-combo"
        )
        .await
        .text()
        .await
        .unwrap(),
        "healthy"
    );
    assert_eq!(limited_requests.load(Ordering::SeqCst), 3);

    terminal_task.abort();
    let banned = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (banned_base, banned_task) = gateway(banned).await;
    limited_status.store(StatusCode::FORBIDDEN.as_u16() as usize, Ordering::SeqCst);
    *limited_body.write().await =
        r#"{"error":{"message":"your account has been suspended"}}"#.to_owned();
    assert_eq!(
        client
            .delete(format!("{banned_base}/api/admin/provider-health/limited"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    for _ in 0..2 {
        assert_eq!(
            chat_model(&client, &banned_base, RUST_CLIENT_KEY, "availability-combo")
                .await
                .text()
                .await
                .unwrap(),
            "healthy"
        );
    }
    assert_eq!(limited_requests.load(Ordering::SeqCst), 4);
    let health = client
        .get(format!("{banned_base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let health: serde_json::Value = serde_json::from_str(&health).unwrap();
    let limited = health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "limited")
        .unwrap();
    assert_eq!(limited["terminal_status"], "banned");
    assert_eq!(limited["connection_last_status"], 403);

    banned_task.abort();
    let banned_restart = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (banned_restart_base, banned_restart_task) = gateway(banned_restart).await;
    assert_eq!(
        chat_model(
            &client,
            &banned_restart_base,
            RUST_CLIENT_KEY,
            "availability-combo"
        )
        .await
        .text()
        .await
        .unwrap(),
        "healthy"
    );
    assert_eq!(limited_requests.load(Ordering::SeqCst), 4);

    banned_restart_task.abort();
    let ambiguous = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (ambiguous_base, ambiguous_task) = gateway(ambiguous).await;
    assert_eq!(
        client
            .put(format!("{ambiguous_base}/api/admin/providers/limited"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "provider":"mistral",
                    "upstream_url":limited_url,
                    "api_key":"limited-secret"
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    limited_status.store(StatusCode::UNAUTHORIZED.as_u16() as usize, Ordering::SeqCst);
    *limited_body.write().await = r#"{"detail":"Unauthorized"}"#.to_owned();
    for _ in 0..2 {
        assert_eq!(
            chat_model(
                &client,
                &ambiguous_base,
                RUST_CLIENT_KEY,
                "availability-combo"
            )
            .await
            .text()
            .await
            .unwrap(),
            "healthy"
        );
    }
    assert_eq!(limited_requests.load(Ordering::SeqCst), 5);
    let health = client
        .get(format!("{ambiguous_base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let health: serde_json::Value = serde_json::from_str(&health).unwrap();
    let limited = health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "limited")
        .unwrap();
    assert_eq!(limited["terminal_status"], serde_json::Value::Null);
    assert_eq!(limited["ambiguous_auth_strikes"], 1);
    assert_eq!(limited["ambiguous_auth_retry_limit"], 3);
    assert_eq!(limited["connection_last_status"], 401);

    ambiguous_task.abort();
    let ambiguous_restart = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (ambiguous_restart_base, ambiguous_restart_task) = gateway(ambiguous_restart).await;
    assert_eq!(
        chat_model(
            &client,
            &ambiguous_restart_base,
            RUST_CLIENT_KEY,
            "availability-combo"
        )
        .await
        .text()
        .await
        .unwrap(),
        "healthy"
    );
    assert_eq!(limited_requests.load(Ordering::SeqCst), 5);

    ambiguous_restart_task.abort();
    limited_task.abort();
    healthy_task.abort();
    database.close().await.unwrap();
}

#[tokio::test]
async fn model_lockout_is_scoped_without_poisoning_the_provider_connection() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("model-lockout.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (scoped_url, missing_requests, missing_status, missing_body, scoped_task) =
        model_scoped_provider("scoped-secret").await;
    let (fallback_url, fallback_task) = provider("model-fallback-secret", "fallback-ok").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    for (id, upstream_url, api_key) in [
        ("scoped", scoped_url, "scoped-secret"),
        ("model-fallback", fallback_url, "model-fallback-secret"),
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
                        "api_key":api_key,
                        "rate_limit_scope": if id == "scoped" { "model" } else { "auto" }
                    })
                    .to_string(),
                )
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/model-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(
                serde_json::json!({
                    "label":"Model lockout client",
                    "api_key":RUST_CLIENT_KEY,
                    "scopes":["inference:chat"],
                    "allowed_endpoints":["chat"],
                    "allowed_models":[
                        "missing-combo","working-combo","missing-model","working-model"
                    ],
                    "allowed_provider_ids":["scoped","model-fallback"]
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for (combo, fallback, targets) in [
        (
            "missing-combo",
            true,
            serde_json::json!([
                {"provider_id":"scoped","model":"missing-model"},
                {"provider_id":"model-fallback","model":"working-model"}
            ]),
        ),
        (
            "working-combo",
            false,
            serde_json::json!([
                {"provider_id":"scoped","model":"working-model"}
            ]),
        ),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/admin/combos/{combo}"))
                .bearer_auth(ADMIN_KEY)
                .header(header::CONTENT_TYPE.as_str(), "application/json")
                .body(
                    serde_json::json!({
                        "strategy":"priority",
                        "fallback":fallback,
                        "targets":targets
                    })
                    .to_string(),
                )
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }

    for _ in 0..2 {
        assert_eq!(
            chat_model(&client, &base, RUST_CLIENT_KEY, "missing-combo")
                .await
                .text()
                .await
                .unwrap(),
            "fallback-ok"
        );
    }
    assert_eq!(missing_requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "working-combo")
            .await
            .text()
            .await
            .unwrap(),
        "model-ok"
    );
    let health = client
        .get(format!("{base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let health: serde_json::Value = serde_json::from_str(&health).unwrap();
    let scoped = health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "scoped")
        .unwrap();
    assert_eq!(scoped["connection_last_status"], serde_json::Value::Null);
    assert_eq!(scoped["model_lockouts"][0]["model"], "missing-model");
    assert_eq!(scoped["model_lockouts"][0]["status"], 404);
    assert_eq!(
        client
            .delete(format!("{base}/api/admin/provider-health/scoped"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "missing-combo")
            .await
            .text()
            .await
            .unwrap(),
        "fallback-ok"
    );
    assert_eq!(missing_requests.load(Ordering::SeqCst), 2);

    missing_status.store(429, Ordering::SeqCst);
    assert_eq!(
        client
            .delete(format!("{base}/api/admin/provider-health/scoped"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    for _ in 0..2 {
        assert_eq!(
            chat_model(&client, &base, RUST_CLIENT_KEY, "missing-combo")
                .await
                .text()
                .await
                .unwrap(),
            "fallback-ok"
        );
    }
    assert_eq!(missing_requests.load(Ordering::SeqCst), 3);
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "working-combo")
            .await
            .text()
            .await
            .unwrap(),
        "model-ok"
    );
    let health = client
        .get(format!("{base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let health: serde_json::Value = serde_json::from_str(&health).unwrap();
    let scoped = health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "scoped")
        .unwrap();
    assert_eq!(scoped["connection_last_status"], serde_json::Value::Null);
    assert_eq!(scoped["model_lockouts"][0]["status"], 429);
    let providers = client
        .get(format!("{base}/api/admin/providers"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let providers: serde_json::Value = serde_json::from_str(&providers).unwrap();
    let scoped = providers["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == "scoped")
        .unwrap();
    assert_eq!(scoped["rate_limit_scope"], "model");

    missing_status.store(402, Ordering::SeqCst);
    assert_eq!(
        client
            .delete(format!("{base}/api/admin/provider-health/scoped"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    for _ in 0..2 {
        assert_eq!(
            chat_model(&client, &base, RUST_CLIENT_KEY, "missing-combo")
                .await
                .text()
                .await
                .unwrap(),
            "fallback-ok"
        );
    }
    assert_eq!(missing_requests.load(Ordering::SeqCst), 4);
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "working-combo")
            .await
            .text()
            .await
            .unwrap(),
        "model-ok"
    );
    let health = client
        .get(format!("{base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let health: serde_json::Value = serde_json::from_str(&health).unwrap();
    let scoped = health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "scoped")
        .unwrap();
    assert_eq!(scoped["terminal_status"], serde_json::Value::Null);
    assert_eq!(scoped["connection_last_status"], serde_json::Value::Null);
    assert_eq!(scoped["model_lockouts"][0]["status"], 402);

    missing_status.store(StatusCode::UNAUTHORIZED.as_u16() as usize, Ordering::SeqCst);
    *missing_body.write().await = serde_json::json!({
        "error": {"message":"Model missing-model is not supported for format oa-compat"}
    })
    .to_string();
    assert_eq!(
        client
            .delete(format!("{base}/api/admin/provider-health/scoped"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    for _ in 0..2 {
        assert_eq!(
            chat_model(&client, &base, RUST_CLIENT_KEY, "missing-combo")
                .await
                .text()
                .await
                .unwrap(),
            "fallback-ok"
        );
    }
    assert_eq!(missing_requests.load(Ordering::SeqCst), 5);
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "working-combo")
            .await
            .text()
            .await
            .unwrap(),
        "model-ok"
    );
    let health = client
        .get(format!("{base}/api/admin/provider-health"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let health: serde_json::Value = serde_json::from_str(&health).unwrap();
    let scoped = health["provider_health"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider_id"] == "scoped")
        .unwrap();
    assert_eq!(scoped["terminal_status"], serde_json::Value::Null);
    assert_eq!(scoped["connection_last_status"], serde_json::Value::Null);
    assert_eq!(scoped["model_lockouts"][0]["status"], 401);

    gateway_task.abort();
    let restarted = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (restarted_base, restarted_task) = gateway(restarted).await;
    assert_eq!(
        chat_model(&client, &restarted_base, RUST_CLIENT_KEY, "missing-combo")
            .await
            .text()
            .await
            .unwrap(),
        "fallback-ok"
    );
    assert_eq!(missing_requests.load(Ordering::SeqCst), 5);

    restarted_task.abort();
    scoped_task.abort();
    fallback_task.abort();
    database.close().await.unwrap();
}

#[tokio::test]
async fn restricted_empty_model_access_survives_updates_and_restart() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("model-access.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (upstream, provider_task) = provider("model-access-secret", "allowed").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (path, body) in [
        (
            "providers/access-provider",
            serde_json::json!({"provider":"openai","upstream_url":upstream,"api_key":"model-access-secret"}),
        ),
        (
            "combos/access-combo",
            serde_json::json!({"protocol":"openai","strategy":"priority","fallback":true,"targets":[{"provider_id":"access-provider","model":"gpt-4o"}]}),
        ),
        (
            "client-keys/access-client",
            serde_json::json!({"label":"Restricted","api_key":RUST_CLIENT_KEY,"model_access_mode":"restricted","allowed_models":[]}),
        ),
    ] {
        let response = client
            .put(format!("{base}/api/admin/{path}"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(body.to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "{}",
            response.text().await.unwrap()
        );
    }
    // Old callers that omit the mode cannot widen an existing restricted key.
    let response = client
        .put(format!("{base}/api/admin/client-keys/access-client"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(r#"{"label":"Renamed"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(body["client_key"]["model_access_mode"], "restricted");
    gateway_task.abort();
    let _ = gateway_task.await;
    database.close().await.unwrap();

    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    assert_eq!(
        database.client_keys().await.unwrap()[0].model_access_mode,
        "restricted"
    );
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (base, gateway_task) = gateway(control).await;
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "access-combo")
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let response = client
        .get(format!("{base}/v1/models"))
        .bearer_auth(RUST_CLIENT_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(body["data"], serde_json::json!([]));

    for (mode, allowed, blocked, expected_mode, expected_status) in [
        (
            "restricted",
            vec!["gpt-4o"],
            vec![],
            "restricted",
            StatusCode::OK,
        ),
        (
            "all",
            vec!["other-model"],
            vec![],
            "restricted",
            StatusCode::FORBIDDEN,
        ),
        ("all", vec![], vec!["gpt-4o"], "all", StatusCode::FORBIDDEN),
        ("all", vec![], vec![], "all", StatusCode::OK),
    ] {
        let response = client.put(format!("{base}/api/admin/client-keys/access-client")).bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(serde_json::json!({"label":"Policy","model_access_mode":mode,"allowed_models":allowed,"blocked_models":blocked}).to_string())
            .send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_str(&response.text().await.unwrap()).unwrap();
        assert_eq!(body["client_key"]["model_access_mode"], expected_mode);
        assert_eq!(
            chat_model(&client, &base, RUST_CLIENT_KEY, "access-combo")
                .await
                .status(),
            expected_status
        );
    }
    let response = client
        .put(format!("{base}/api/admin/client-keys/access-client"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(r#"{"label":"Bad policy","model_access_mode":"typo"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(database.client_keys().await.unwrap()[0].label, "Policy");

    // Combo grants are independent of direct model grants, as in the legacy product.
    // Endpoint/provider gates still apply, and catalog visibility must match dispatch.
    for (grants, providers, endpoints, expected) in [
        (
            serde_json::json!(["combo/access-combo"]),
            vec![],
            vec![],
            StatusCode::OK,
        ),
        (
            serde_json::json!(["combo/*"]),
            vec!["other-provider"],
            vec![],
            StatusCode::FORBIDDEN,
        ),
        (
            serde_json::json!(["combo/*"]),
            vec![],
            vec!["embeddings"],
            StatusCode::FORBIDDEN,
        ),
        (serde_json::json!([]), vec![], vec![], StatusCode::FORBIDDEN),
        (
            serde_json::json!(["another-combo"]),
            vec![],
            vec![],
            StatusCode::FORBIDDEN,
        ),
        (
            serde_json::Value::Null,
            vec![],
            vec![],
            StatusCode::FORBIDDEN,
        ),
        (
            serde_json::json!(["access-combo"]),
            vec![],
            vec![],
            StatusCode::OK,
        ),
    ] {
        let body = serde_json::json!({"label":"Combo access", "model_access_mode":"restricted",
            "allowed_models":[], "blocked_models":["gpt-4o","access-combo"], "allowed_combos":grants,
            "allowed_provider_ids":providers, "allowed_endpoints":endpoints });
        let response = client
            .put(format!("{base}/api/admin/client-keys/access-client"))
            .bearer_auth(ADMIN_KEY)
            .header(header::CONTENT_TYPE.as_str(), "application/json")
            .body(body.to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        for name in ["access-combo", "combo/access-combo"] {
            assert_eq!(
                chat_model(&client, &base, RUST_CLIENT_KEY, name)
                    .await
                    .status(),
                expected,
                "{body} / {name}"
            );
        }
        let response = client
            .get(format!("{base}/v1/models"))
            .bearer_auth(RUST_CLIENT_KEY)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let catalog: serde_json::Value =
            serde_json::from_str(&response.text().await.unwrap()).unwrap();
        assert_eq!(
            catalog["data"].as_array().unwrap().len(),
            usize::from(expected == StatusCode::OK)
        );
    }
    // An older caller renaming a key must not drop its explicit combo grants.
    let response = client
        .put(format!("{base}/api/admin/client-keys/access-client"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(r#"{"label":"Keep combos"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(
        body["client_key"]["allowed_combos"],
        serde_json::json!(["access-combo"])
    );
    let saved = database.client_keys().await.unwrap().remove(0);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&saved.allowed_combos_json).unwrap(),
        serde_json::json!(["access-combo"])
    );
    let response = client.put(format!("{base}/api/admin/client-keys/limited-combos")).bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(serde_json::json!({"label":"Limited combos","api_key":"combo-rate-limited-client-000001","allowed_combos":["combo/*"],"model_access_mode":"restricted","max_requests_per_minute":1}).to_string())
        .send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        chat_model(
            &client,
            &base,
            "combo-rate-limited-client-000001",
            "access-combo"
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        chat_model(
            &client,
            &base,
            "combo-rate-limited-client-000001",
            "access-combo"
        )
        .await
        .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    let response = client
        .put(format!("{base}/api/admin/client-keys/access-client"))
        .bearer_auth(ADMIN_KEY)
        .header(header::CONTENT_TYPE.as_str(), "application/json")
        .body(r#"{"label":"Bad combos","allowed_combos":["*"]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    gateway_task.abort();
    provider_task.abort();
}

include!("cases/provider_headers.rs");

include!("cases/provider_discovery.rs");

include!("cases/provider_protocol.rs");

include!("cases/provider_nodes.rs");

include!("cases/provider_no_auth.rs");
