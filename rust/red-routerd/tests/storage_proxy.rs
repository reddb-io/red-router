use axum::{routing::post, Router};
use red_routerd::storage::{Backend, Database};
use std::{
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tempfile::TempDir;
use url::Url;

// Windows CI starts several child proxies in parallel and may spend more than
// twenty seconds loading the embedded storage build even though the process is
// healthy. Keep the ordinary bound tight while allowing the slower runner to
// prove readiness instead of reporting an empty-log startup failure.
const PROXY_STARTUP_TIMEOUT: Duration = if cfg!(windows) {
    Duration::from_secs(60)
} else {
    Duration::from_secs(30)
};

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn proxy_roundtrip(backend: Backend, database_url: &str, remote: bool) {
    let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_addr = provider.local_addr().unwrap();
    let provider_task = tokio::spawn(async move {
        axum::serve(
            provider,
            Router::new().route(
                "/v1/chat/completions",
                post(|| async { "persisted-provider" }),
            ),
        )
        .await
        .unwrap();
    });
    let db = Database::connect(backend, database_url).await.unwrap();
    let upstream = format!("http://{provider_addr}/v1/chat/completions");
    if remote {
        assert_eq!(
            std::env::var("RED_ROUTER_TEST_DISPOSABLE").as_deref(),
            Ok("1")
        );
        db.set_upstream(&upstream).await.unwrap();
    } else {
        db.seed(&upstream).await.unwrap();
    }
    db.close().await.unwrap();
    drop(db);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = listener.local_addr().unwrap();
    drop(listener);
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_millis(250))
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let base = format!("http://{proxy_addr}");
    let logs = TempDir::new().unwrap();
    for attempt in 0..2 {
        let log = logs.path().join(format!("proxy-{attempt}.log"));
        let mut command = Command::new(env!("CARGO_BIN_EXE_red-routerd"));
        command
            .env("RED_ROUTER_DATABASE_URL", database_url)
            .env("RED_ROUTER_LISTEN", proxy_addr.to_string())
            .env("RED_ROUTER_CLIENT_KEY", "test-client-key-12345")
            .env("RED_ROUTER_PROVIDER_KEY", "test-provider-key")
            // Existing database configuration must win over a seed value.
            .env(
                "RED_ROUTER_UPSTREAM_URL",
                "http://127.0.0.1:1/v1/chat/completions",
            )
            .stdout(Stdio::null())
            .stderr(Stdio::from(std::fs::File::create(&log).unwrap()));
        match backend {
            Backend::ReddbEmbedded => {
                command.env("RED_ROUTER_DB_BACKEND", "reddb-embedded");
            }
            Backend::Sqlite => {
                command.env("RED_ROUTER_DB_BACKEND", "sqlite");
            }
            Backend::ReddbRemote => {
                command.env("RED_ROUTER_DB_BACKEND", "reddb-remote");
            }
            Backend::Postgres => {
                command.env("RED_ROUTER_DB_BACKEND", "postgres");
            }
        }
        let mut process = Process(command.spawn().unwrap());
        let mut ready = false;
        let deadline = Instant::now() + PROXY_STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            if process.0.try_wait().unwrap().is_some() {
                break;
            }
            if client
                .get(format!("{base}/healthz"))
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            ready,
            "proxy did not start (attempt {attempt}, status {:?}): {}",
            process.0.try_wait().unwrap(),
            std::fs::read_to_string(&log).unwrap_or_default()
        );
        let response = client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth("test-client-key-12345")
            .header("content-type", "application/json")
            .body(r#"{"model":"example","messages":[]}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.text().await.unwrap(), "persisted-provider");
        drop(process);
    }
    provider_task.abort();
}

#[tokio::test]
async fn proxy_uses_sqlite_after_restart() {
    let temp = TempDir::new().unwrap();
    let file = Url::from_file_path(temp.path().join("config.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    proxy_roundtrip(Backend::Sqlite, &url, false).await;
}

#[tokio::test]
async fn proxy_defaults_to_sqlite_and_keeps_configuration_after_restart() {
    let folder = TempDir::new().unwrap();
    let workdir = folder.path().join("database directory with spaces");
    std::fs::create_dir(&workdir).unwrap();
    let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_addr = provider.local_addr().unwrap();
    let provider_task = tokio::spawn(async move {
        let app = Router::new().route("/v1/chat/completions", post(|| async { "default-sqlite" }));
        axum::serve(provider, app).await.unwrap();
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = listener.local_addr().unwrap();
    drop(listener);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let base = format!("http://{proxy_addr}");
    for attempt in 0..2 {
        let log = workdir.join(format!("default-proxy-{attempt}.log"));
        let seed = if attempt == 0 {
            format!("http://{provider_addr}/v1/chat/completions")
        } else {
            "http://127.0.0.1:1/v1/chat/completions".to_string()
        };
        let mut process = Process(
            Command::new(env!("CARGO_BIN_EXE_red-routerd"))
                .current_dir(&workdir)
                .env_remove("RED_ROUTER_DB_BACKEND")
                .env_remove("RED_ROUTER_DATABASE_URL")
                .env_remove("RED_ROUTER_ROUTES_JSON")
                .env_remove("RED_ROUTER_CLIENT_POLICIES_JSON")
                .env("RED_ROUTER_LISTEN", proxy_addr.to_string())
                .env("RED_ROUTER_CLIENT_KEY", "test-client-key-12345")
                .env("RED_ROUTER_PROVIDER_KEY", "test-provider-key")
                .env("RED_ROUTER_UPSTREAM_URL", seed)
                .stdout(Stdio::null())
                .stderr(Stdio::from(std::fs::File::create(&log).unwrap()))
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + PROXY_STARTUP_TIMEOUT;
        loop {
            assert!(
                process.0.try_wait().unwrap().is_none(),
                "proxy exited: {}",
                std::fs::read_to_string(&log).unwrap_or_default()
            );
            if client
                .get(format!("{base}/healthz"))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "proxy startup timed out: {}",
                std::fs::read_to_string(&log).unwrap_or_default()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let response = client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth("test-client-key-12345")
            .body(r#"{"model":"example","messages":[]}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.text().await.unwrap(), "default-sqlite");
        drop(process);
    }
    assert!(workdir.join("red-router.sqlite").is_file());
    assert!(!workdir.join("red-router.rdb").exists());
    provider_task.abort();
}

#[test]
fn existing_default_reddb_requires_explicit_backend_choice() {
    let folder = TempDir::new().unwrap();
    std::fs::write(folder.path().join("red-router.rdb"), b"existing-authority").unwrap();
    let command = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_red-routerd"));
        command
            .arg("set-upstream")
            .current_dir(folder.path())
            .env_remove("RED_ROUTER_DB_BACKEND")
            .env_remove("RED_ROUTER_DATABASE_URL")
            .env("RED_ROUTER_CLIENT_KEY", "test-client-key-12345")
            .env("RED_ROUTER_PROVIDER_KEY", "test-provider-key")
            .env(
                "RED_ROUTER_UPSTREAM_URL",
                "http://127.0.0.1:1/v1/chat/completions",
            );
        command
    };
    let rejected = command().output().unwrap();
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("existing default RedDB found"));
    assert!(!folder.path().join("red-router.sqlite").exists());
    let selected = command()
        .env("RED_ROUTER_DB_BACKEND", "sqlite")
        .output()
        .unwrap();
    assert!(
        selected.status.success(),
        "{}",
        String::from_utf8_lossy(&selected.stderr)
    );
    assert!(folder.path().join("red-router.sqlite").is_file());
    assert_eq!(
        std::fs::read(folder.path().join("red-router.rdb")).unwrap(),
        b"existing-authority"
    );
}

#[tokio::test]
async fn proxy_loads_model_routes_from_environment() {
    use axum::http::{header, HeaderMap};

    let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_addr = provider.local_addr().unwrap();
    let upstream = format!("http://{provider_addr}/v1/chat/completions");
    let provider_task = tokio::spawn(async move {
        let router = Router::new().route(
            "/v1/chat/completions",
            post(|headers: HeaderMap, body: String| async move {
                assert_eq!(
                    headers.get(header::AUTHORIZATION).unwrap(),
                    "Bearer route-secret"
                );
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&body).unwrap()["model"],
                    "actual-model"
                );
                "routed-provider"
            }),
        );
        axum::serve(provider, router).await.unwrap();
    });
    let temp = TempDir::new().unwrap();
    let file = Url::from_file_path(temp.path().join("routes.sqlite")).unwrap();
    let database_url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = listener.local_addr().unwrap();
    drop(listener);
    let routes = serde_json::json!([{"model":"alias", "targets":[{
        "url":upstream, "model":"actual-model", "api_key_env":"TEST_ROUTER_PROVIDER_KEY"
    }]}])
    .to_string();
    let log = temp.path().join("proxy.log");
    let mut process = Process(
        Command::new(env!("CARGO_BIN_EXE_red-routerd"))
            .env("RED_ROUTER_DB_BACKEND", "sqlite")
            .env("RED_ROUTER_DATABASE_URL", database_url)
            .env("RED_ROUTER_LISTEN", proxy_addr.to_string())
            .env("RED_ROUTER_UPSTREAM_URL", &upstream)
            .env("RED_ROUTER_CLIENT_KEY", "test-client-key-12345")
            .env("RED_ROUTER_PROVIDER_KEY", "unused-seed-key")
            .env("RED_ROUTER_ROUTES_JSON", routes)
            .env(
                "RED_ROUTER_CLIENT_POLICIES_JSON",
                r#"[{"api_key_env":"TEST_ROUTER_CLIENT_KEY","allowed_routes":["alias"]}]"#,
            )
            .env("TEST_ROUTER_CLIENT_KEY", "route-client-key-12345")
            .env("TEST_ROUTER_PROVIDER_KEY", "route-secret")
            .stdout(Stdio::null())
            .stderr(Stdio::from(std::fs::File::create(&log).unwrap()))
            .spawn()
            .unwrap(),
    );
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let base = format!("http://{proxy_addr}");
    let deadline = Instant::now() + PROXY_STARTUP_TIMEOUT;
    let mut ready = false;
    while Instant::now() < deadline {
        if process.0.try_wait().unwrap().is_some() {
            break;
        }
        if client
            .get(format!("{base}/healthz"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        ready,
        "proxy did not start: {}",
        std::fs::read_to_string(log).unwrap_or_default()
    );
    let old_key = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("test-client-key-12345")
        .body(r#"{"model":"alias","messages":[]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(old_key.status(), 401);
    let response = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("route-client-key-12345")
        .body(r#"{"model":"alias","messages":[]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().await.unwrap(), "routed-provider");
    drop(process);
    provider_task.abort();
}

#[cfg(feature = "reddb-embedded")]
#[tokio::test]
async fn proxy_uses_explicit_embedded_reddb_after_restart() {
    let temp = TempDir::new().unwrap();
    let url = Url::from_file_path(temp.path().join("config.rdb")).unwrap();
    proxy_roundtrip(Backend::ReddbEmbedded, url.as_str(), false).await;
}

#[tokio::test]
async fn proxy_uses_remote_postgres_after_restart() {
    if let Ok(url) = std::env::var("RED_ROUTER_TEST_POSTGRES_URL") {
        proxy_roundtrip(Backend::Postgres, &url, true).await;
    }
}

#[tokio::test]
async fn proxy_uses_remote_reddb_after_restart() {
    if let Ok(url) = std::env::var("RED_ROUTER_TEST_REDDB_URL") {
        proxy_roundtrip(Backend::ReddbRemote, &url, true).await;
    }
}

#[tokio::test]
async fn proxy_uses_authenticated_tls_reddb_after_restart() {
    if let Ok(url) = std::env::var("RED_ROUTER_TEST_REDDB_TLS_URL") {
        proxy_roundtrip(Backend::ReddbRemote, &url, true).await;
    }
}

#[tokio::test]
async fn custom_protocol_bootstrap_preserves_saved_and_disabled_accounts_after_restart() {
    let temp = TempDir::new().unwrap();
    let file = Url::from_file_path(temp.path().join("managed.sqlite")).unwrap();
    let database_url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/custom/infer", provider.local_addr().unwrap());
    let provider_task = tokio::spawn(async move {
        axum::serve(provider, Router::new().route("/custom/infer", post(|headers: axum::http::HeaderMap| async move {
            assert_eq!(headers["authorization"], "Bearer saved-provider-secret");
            axum::Json(serde_json::json!({"id":"fixture","object":"chat.completion","model":"fixture-model","choices":[{"index":0,"message":{"role":"assistant","content":"saved account"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}))
        }))).await.unwrap();
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let admin = "test-admin-bootstrap-1234567890-abcdef";
    for attempt in 0..3 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = listener.local_addr().unwrap();
        drop(listener);
        let base = format!("http://{proxy_addr}");
        let log = temp.path().join(format!("managed-{attempt}.log"));
        let mut process = Process(
            Command::new(env!("CARGO_BIN_EXE_red-routerd"))
                .current_dir(temp.path())
                .env("RED_ROUTER_DB_BACKEND", "sqlite")
                .env("RED_ROUTER_DATABASE_URL", &database_url)
                .env("RED_ROUTER_LISTEN", proxy_addr.to_string())
                .env("RED_ROUTER_ADMIN_KEY", admin)
                .env(
                    "STORAGE_ENCRYPTION_KEY",
                    "test-storage-bootstrap-1234567890",
                )
                .env("RED_ROUTER_CLIENT_KEY", "test-client-bootstrap-1234567890")
                .env(
                    "RED_ROUTER_PROVIDER_KEY",
                    if attempt == 0 {
                        "saved-provider-secret"
                    } else {
                        "must-not-overwrite"
                    },
                )
                .env(
                    "RED_ROUTER_PROVIDER_PROTOCOL",
                    if attempt == 0 {
                        "openai"
                    } else {
                        "invalid-protocol-must-be-ignored"
                    },
                )
                .env("RED_ROUTER_UPSTREAM_URL", &upstream)
                .env_remove("RED_ROUTER_ROUTES_JSON")
                .env_remove("RED_ROUTER_CLIENT_POLICIES_JSON")
                .stdout(Stdio::null())
                .stderr(Stdio::from(std::fs::File::create(&log).unwrap()))
                .spawn()
                .unwrap(),
        );
        let mut ready = false;
        let deadline = Instant::now() + PROXY_STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            if process.0.try_wait().unwrap().is_some() {
                break;
            }
            if client
                .get(format!("{base}/healthz"))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            ready,
            "attempt {attempt}: {}",
            std::fs::read_to_string(&log).unwrap_or_default()
        );
        let response = client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth("test-client-bootstrap-1234567890")
            .json(&serde_json::json!({"model":"fixture-model","messages":[]}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status().as_u16(),
            if attempt < 2 { 200 } else { 503 }
        );
        if attempt == 1 {
            assert_eq!(
                client
                    .delete(format!("{base}/api/admin/providers/default"))
                    .bearer_auth(admin)
                    .send()
                    .await
                    .unwrap()
                    .status()
                    .as_u16(),
                204
            );
        }
        drop(process);
    }
    let db = Database::connect(Backend::Sqlite, &database_url)
        .await
        .unwrap();
    let providers = db.providers().await.unwrap();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0].protocol, "openai");
    assert!(!providers[0].enabled);
    db.close().await.unwrap();
    provider_task.abort();
}
