//! Explicit opt-in live OpenRouter smoke test; no key or response body is logged.
use std::{
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tempfile::TempDir;

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
#[ignore = "requires an OpenRouter key and live network access"]
async fn openrouter_live_chat_and_stream_through_sqlite_gateway() {
    let provider_key = std::env::var("OPENROUTER_API_KEY").expect("OPENROUTER_API_KEY is required");
    let folder = TempDir::new().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let routes = serde_json::json!([
        {"model":"direct-free","protocol":"openai","targets":[{"url":"https://openrouter.ai/api/v1/chat/completions","model":"openrouter/free","api_key_env":"LIVE_OPENROUTER_KEY"}]},
        {"model":"translated-free","protocol":"openai-to-anthropic","targets":[{"url":"https://openrouter.ai/api/v1/messages","model":"openrouter/free","api_key_env":"LIVE_OPENROUTER_KEY","auth":"bearer"}]}
    ]).to_string();
    let mut process = Process(
        Command::new(env!("CARGO_BIN_EXE_red-routerd"))
            .current_dir(folder.path())
            .env_remove("RED_ROUTER_DB_BACKEND")
            .env_remove("RED_ROUTER_DATABASE_URL")
            .env_remove("RED_ROUTER_CLIENT_POLICIES_JSON")
            .env("RED_ROUTER_LISTEN", address.to_string())
            .env(
                "RED_ROUTER_UPSTREAM_URL",
                "https://openrouter.ai/api/v1/chat/completions",
            )
            .env("RED_ROUTER_CLIENT_KEY", "live-test-client-key-12345")
            .env("RED_ROUTER_PROVIDER_KEY", &provider_key)
            .env("LIVE_OPENROUTER_KEY", &provider_key)
            .env("RED_ROUTER_ROUTES_JSON", routes)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start gateway"),
    );
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(90))
        .build()
        .unwrap();
    let base = format!("http://{address}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(
            process.0.try_wait().unwrap().is_none(),
            "gateway exited during startup"
        );
        if client
            .get(format!("{base}/healthz"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            break;
        }
        assert!(Instant::now() < deadline, "gateway did not start");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for (model, stream) in [
        ("direct-free", false),
        ("direct-free", true),
        ("translated-free", false),
        ("translated-free", true),
    ] {
        let body = serde_json::json!({"model":model,"messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":8,"stream":stream});
        let response = client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth("live-test-client-key-12345")
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .expect("live request");
        assert_eq!(
            response.status(),
            reqwest::StatusCode::OK,
            "live provider rejected request"
        );
        let body = response.text().await.expect("live response");
        if stream {
            assert!(
                body.lines().any(|line| line.trim() == "data: [DONE]"),
                "live stream incomplete"
            );
            assert!(
                body.lines()
                    .filter_map(|line| line.strip_prefix("data: "))
                    .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                    .any(|event| event
                        .pointer("/choices/0/delta/content")
                        .and_then(|v| v.as_str())
                        .is_some_and(|text| !text.is_empty())),
                "live stream contained no content"
            );
        } else {
            let json: serde_json::Value =
                serde_json::from_str(&body).expect("valid completion JSON");
            assert!(
                json.pointer("/choices/0/message/content")
                    .and_then(|v| v.as_str())
                    .is_some_and(|text| !text.is_empty()),
                "live completion contained no content"
            );
        }
    }
    assert!(folder.path().join("red-router.sqlite").is_file());
}
