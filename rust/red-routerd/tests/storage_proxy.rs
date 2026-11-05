use axum::{routing::post, Router};
use red_routerd::storage::{Backend, Database};
use std::{
    process::{Child, Command, Stdio},
    time::Duration,
};
use tempfile::TempDir;
use url::Url;

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn proxy_uses_persisted_upstream_after_restart() {
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
    let temp = TempDir::new().unwrap();
    let file = Url::from_file_path(temp.path().join("config.sqlite")).unwrap();
    let database_url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Database::connect(Backend::Sqlite, &database_url)
        .await
        .unwrap();
    db.seed(&format!("http://{provider_addr}/v1/chat/completions"))
        .await
        .unwrap();
    db.close().await.unwrap();
    drop(db);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = listener.local_addr().unwrap();
    drop(listener);
    let child = Command::new(env!("CARGO_BIN_EXE_red-routerd"))
        .env("RED_ROUTER_DB_BACKEND", "sqlite")
        .env("RED_ROUTER_DATABASE_URL", &database_url)
        .env("RED_ROUTER_LISTEN", proxy_addr.to_string())
        .env("RED_ROUTER_CLIENT_KEY", "test-client-key-12345")
        .env("RED_ROUTER_PROVIDER_KEY", "test-provider-key")
        // Existing database configuration must win over a seed value.
        .env(
            "RED_ROUTER_UPSTREAM_URL",
            "http://127.0.0.1:1/v1/chat/completions",
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _process = Process(child);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = format!("http://{proxy_addr}");
    let mut ready = false;
    for _ in 0..100 {
        if client.get(format!("{base}/healthz")).send().await.is_ok() {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ready, "proxy did not start");
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
    provider_task.abort();
}
