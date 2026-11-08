use axum::response::IntoResponse;
use axum::{routing::post, Router};
use futures_util::{stream, StreamExt};
use red_routerd::product_combo::ProductCombo;
use red_routerd::{
    control_plane::ControlPlane,
    product::ProductConnection,
    router,
    storage::{Backend, Database},
    ProxyState,
};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::io::{BufRead, Read, Write};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tempfile::TempDir;
use url::Url;

const ENCRYPTED: &str = "enc:v1:07070707070707070707070707070707:c08df6423606efea3e7c0312a4ec91a5e0a8d368:d4c8fcd1abdb884abc46108ca32ae870";

async fn fixture() -> (TempDir, SqliteConnection) {
    let dir = TempDir::new().unwrap();
    let options = SqliteConnectOptions::new()
        .filename(dir.path().join("storage.sqlite"))
        .create_if_missing(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, auth_type TEXT, is_active INTEGER, api_key TEXT, updated_at TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'red', priority INTEGER DEFAULT 0, rate_limited_until TEXT, test_status TEXT, per_key_proxy_enabled INTEGER DEFAULT 0, max_concurrent INTEGER, provider_specific_data TEXT, rate_limit_overrides_json TEXT)")
        .execute(&mut db).await.unwrap();
    sqlx::query(
        "INSERT INTO provider_connections (id, provider, auth_type, is_active, api_key, updated_at) VALUES ('test', 'openrouter', 'apikey', 1, ?, 'a')",
    )
    .bind(ENCRYPTED)
    .execute(&mut db)
    .await
    .unwrap();
    for statement in [
        "CREATE TABLE api_keys (id TEXT PRIMARY KEY, key TEXT NOT NULL, key_hash TEXT, is_active INTEGER DEFAULT 1, is_banned INTEGER DEFAULT 0, revoked_at TEXT, expires_at TEXT, max_requests_per_day INTEGER, max_requests_per_minute INTEGER, throttle_delay_ms INTEGER, max_sessions INTEGER DEFAULT 0, usage_limit_enabled INTEGER DEFAULT 0, disable_non_public_models INTEGER DEFAULT 0, auto_resolve INTEGER DEFAULT 0, access_schedule TEXT, proxy_id TEXT, tenant_id TEXT DEFAULT 'red', ip_allowlist TEXT, scopes TEXT, rate_limits TEXT, allowed_quotas TEXT DEFAULT '[]', allowed_connections TEXT, allowed_combos TEXT, allowed_models TEXT DEFAULT '[]', blocked_models TEXT, allowed_endpoints TEXT, model_access_mode TEXT DEFAULT 'all')",
        "CREATE TABLE domain_budgets (api_key_id TEXT)",
        "CREATE TABLE api_key_token_limits (api_key_id TEXT, enabled INTEGER)",
        "CREATE TABLE api_key_quota_limits (api_key_id TEXT, tpm_limit INTEGER, rpm_limit INTEGER, monthly_amount_usd REAL)",
        "CREATE TABLE api_key_quota_counters (api_key_id TEXT, dimension_key TEXT, bucket_index INTEGER, consumed REAL, updated_at INTEGER, PRIMARY KEY(api_key_id,dimension_key,bucket_index))",
        "CREATE TABLE api_key_daily_token_limits (api_key_id TEXT, daily_tokens_limit INTEGER)",
        "CREATE TABLE provider_quota_state (connection_id TEXT)",
        "CREATE TABLE key_group_members (key_id TEXT)",
        "CREATE TABLE budget_assignments (budget_id TEXT)",
        "CREATE TABLE model_combo_mappings (enabled INTEGER)",
        "CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT)",
        "CREATE TABLE combos (name TEXT, data TEXT, context_cache_protection INTEGER DEFAULT 0, tenant_id TEXT DEFAULT 'red')",
    ] { sqlx::query(statement).execute(&mut db).await.unwrap(); }
    (dir, db)
}

#[cfg(unix)]
#[tokio::test]
async fn supervised_reload_keeps_engine_alive_until_active_work_drains() {
    use std::os::unix::fs::PermissionsExt;
    use tokio::sync::oneshot;

    let (dir, mut db) = fixture().await;
    let path = dir.path().join("storage.sqlite");
    sqlx::query(
        "UPDATE provider_connections SET api_key = 'fixture-provider-key' WHERE id = 'test'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO combos (name,data) VALUES ('drain',?)")
        .bind(r#"{"name":"drain","strategy":"priority","models":["openrouter/vendor/a"]}"#)
        .execute(&mut db)
        .await
        .unwrap();
    let combo = ProductCombo::load(&path, "drain").await.unwrap();
    let (connection, _) = ProductConnection::open(&path, "test", None).await.unwrap();
    let connection = connection.with_auto_selection_guard();
    let internal = "fixture-internal-token-12345678901234567890";
    let control = "fixture-control-token-123456789012345678901";
    let engine_address = red_routerd::fastllm_supervisor::reserve_engine_address()
        .await
        .unwrap();
    let endpoint = format!("http://{engine_address}/v1/chat/completions");
    let routes = serde_json::json!([{"model":"drain","fallback":true,"targets":[
        {"url":endpoint,"model":"vendor/a","api_key_env":"ENGINE"}
    ]}])
    .to_string();
    let state = ProxyState::new(
        &endpoint,
        "unused-client-key-12345",
        "fixture-provider-key",
        false,
    )
    .await
    .unwrap()
    .with_routes(&routes, |_| Some(internal.to_owned()), false)
    .await
    .unwrap()
    .with_product_connection(connection.clone())
    .with_product_combo(combo, vec![connection])
    .unwrap()
    .with_product_client_keys()
    .unwrap();
    let (control_address, version, control_task) = red_routerd::fastllm_control::start(
        &path,
        "drain",
        internal,
        control,
        None,
        "127.0.0.1:0".parse().unwrap(),
        true,
    )
    .await
    .unwrap();
    let binary = dir.path().join("fake-fastllm.mjs");
    std::fs::write(
        &binary,
        include_str!("fixtures/fake-fastllm-supervisor.mjs"),
    )
    .unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let control_url = format!("http://{control_address}/snapshot");
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let unguarded = client
        .get(&control_url)
        .bearer_auth(control)
        .header("x-redrouter-memory-only", "1")
        .send()
        .await
        .unwrap();
    assert_eq!(
        unguarded.status(),
        403,
        "supervised engine must prove retry protection"
    );
    let guarded = client
        .get(&control_url)
        .bearer_auth(control)
        .header("x-redrouter-memory-only", "1")
        .header("x-redrouter-no-upstream-retry", "1")
        .send()
        .await
        .unwrap();
    assert_eq!(guarded.status(), 200);
    let (reload_tx, reload_rx) = oneshot::channel();
    let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let (ready_tx, ready_rx) = oneshot::channel();
    let (draining_tx, draining_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let gateway = async move {
        let _ = ready_tx.send(());
        let _ = reload_rx.await;
        let _ = draining_tx.send(());
        let _ = release_rx.await;
        Ok(())
    };
    let task = tokio::spawn(async move {
        red_routerd::fastllm_supervisor::run(
            red_routerd::fastllm_supervisor::Config {
                binary: &binary,
                engine_address,
                control_address,
                control_token: control,
                internal_token: internal,
                version,
            },
            state,
            control_task,
            reload_tx,
            shutdown_rx,
            gateway,
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(10), ready_rx)
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE combos SET data = ? WHERE name = 'drain'")
        .bind(r#"{"name":"drain","strategy":"priority","models":["openrouter/vendor/b"]}"#)
        .execute(&mut db)
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), draining_rx)
        .await
        .unwrap()
        .unwrap();
    let health = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("http://{engine_address}/health"))
        .send()
        .await
        .unwrap();
    assert!(
        health.status().is_success(),
        "engine stopped before active work drained"
    );
    release_tx.send(()).unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert!(result
        .unwrap_err()
        .downcast_ref::<red_routerd::fastllm_supervisor::ReloadRequired>()
        .is_some());
}

#[tokio::test]
async fn fastllm_plan_reads_dashboard_combo_and_refuses_unimplemented_routing() {
    let (dir, mut db) = fixture().await;
    let path = dir.path().join("storage.sqlite");
    sqlx::query("INSERT INTO combos (name,data) VALUES (?,?)")
        .bind("bench")
        .bind(r#"{"name":"bench","strategy":"priority","models":["openrouter/vendor/model"]}"#)
        .execute(&mut db)
        .await
        .unwrap();
    let plan = red_routerd::fastllm_plan::single_target_plan(&path, "bench")
        .await
        .unwrap();
    assert_eq!(plan["format"], "red-router.fastllm.route-plan.v1");
    assert_eq!(plan["frontend_model"], "bench");
    assert_eq!(plan["provider"], "openrouter");
    assert_eq!(plan["product_model"], "openrouter/vendor/model");
    assert_eq!(plan["upstream_model"], "vendor/model");
    assert!(!plan.to_string().contains(ENCRYPTED));

    for unsupported in [
        r#"{"name":"bench","strategy":"priority","models":["openrouter/a","openai/b"]}"#,
        r#"{"name":"bench","strategy":"round-robin","models":["openrouter/a"]}"#,
        r#"{"name":"bench","strategy":"priority","models":[{"kind":"combo-ref","comboName":"other"}]}"#,
    ] {
        sqlx::query("UPDATE combos SET data = ? WHERE name = 'bench'")
            .bind(unsupported)
            .execute(&mut db)
            .await
            .unwrap();
        assert!(
            red_routerd::fastllm_plan::single_target_plan(&path, "bench")
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn product_combo_accepts_pinned_openai_compatible_provider_endpoints() {
    let (dir, mut db) = fixture().await;
    for (provider, expected) in [
        ("groq", "https://api.groq.com/openai/v1/chat/completions"),
        ("cerebras", "https://api.cerebras.ai/v1/chat/completions"),
        ("sambanova", "https://api.sambanova.ai/v1/chat/completions"),
        ("mistral", "https://api.mistral.ai/v1/chat/completions"),
        ("deepseek", "https://api.deepseek.com/chat/completions"),
        ("together", "https://api.together.xyz/v1/chat/completions"),
        ("perplexity", "https://api.perplexity.ai/chat/completions"),
        (
            "fireworks",
            "https://api.fireworks.ai/inference/v1/chat/completions",
        ),
    ] {
        sqlx::query("INSERT INTO provider_connections (id,provider,auth_type,is_active,api_key,updated_at) VALUES (?,?,'apikey',1,'fixture-provider-key','a')")
            .bind(provider).bind(provider).execute(&mut db).await.unwrap();
        let path = dir.path().join("storage.sqlite");
        let id = ProductConnection::select_fill_first(&path, provider)
            .await
            .unwrap();
        let (connection, key) = ProductConnection::open(&path, &id, None).await.unwrap();
        assert_eq!(connection.upstream_url(), expected);
        assert_eq!(key.as_str(), "fixture-provider-key");
        assert!(connection.with_auto_selection_guard().unchanged().await);
    }
    sqlx::query("INSERT INTO combos (name,data) VALUES ('providers',?)")
        .bind(r#"{"name":"providers","strategy":"priority","models":["groq/llama","mistral/large","deepseek/chat"]}"#)
        .execute(&mut db).await.unwrap();
    let combo = ProductCombo::load(&dir.path().join("storage.sqlite"), "providers")
        .await
        .unwrap();
    assert_eq!(
        combo
            .targets
            .iter()
            .map(|target| target.provider.as_str())
            .collect::<Vec<_>>(),
        vec!["groq", "mistral", "deepseek"]
    );
    assert!(red_routerd::product_provider::chat_url("untrusted-provider").is_none());
    assert!(red_routerd::product_provider::supports_model(
        "fireworks",
        "accounts/fireworks/models/example"
    ));
    assert!(red_routerd::product_provider::supports_model(
        "fireworks",
        "accounts/fireworks/routers/example"
    ));
    assert!(!red_routerd::product_provider::supports_model(
        "fireworks",
        "example"
    ));
    sqlx::query("UPDATE combos SET data = ? WHERE name = 'providers'")
        .bind(r#"{"name":"providers","strategy":"priority","models":["fireworks/example"]}"#)
        .execute(&mut db)
        .await
        .unwrap();
    assert!(
        ProductCombo::load(&dir.path().join("storage.sqlite"), "providers")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn internal_fastllm_token_must_not_match_even_disabled_dashboard_keys() {
    let (dir, mut db) = fixture().await;
    let plain = "dashboard-key-with-a-long-plaintext-value";
    let hashed = "dashboard-key-with-a-long-hashed-value";
    let digest = hex::encode(Sha256::digest(hashed.as_bytes()));
    sqlx::query("INSERT INTO api_keys (id,key,is_active) VALUES ('a',?,0)")
        .bind(plain)
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO api_keys (id,key,key_hash,is_active) VALUES ('b','redacted',?,0)")
        .bind(digest)
        .execute(&mut db)
        .await
        .unwrap();
    let (connection, _) = ProductConnection::open(
        &dir.path().join("storage.sqlite"),
        "test",
        Some("fixture-password"),
    )
    .await
    .unwrap();
    assert!(connection.dashboard_key_exists(plain).await.unwrap());
    assert!(connection.dashboard_key_exists(hashed).await.unwrap());
    assert!(!connection
        .dashboard_key_exists("different-internal-token-01234567890")
        .await
        .unwrap());
}

#[tokio::test]
async fn non_streaming_product_usage_is_recorded_and_unhandled_quotas_fail_closed() {
    let (dir, mut db) = fixture().await;
    sqlx::raw_sql(include_str!(
        "../../../src/lib/db/migrations/182_request_cost_ledger_and_key_quota.sql"
    ))
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../src/lib/db/migrations/219_cost_ledger_recovery.sql"
    ))
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../src/lib/db/migrations/226_shared_usage_reservations.sql"
    ))
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::raw_sql("ALTER TABLE request_cost_ledger ADD COLUMN tenant_id TEXT; ALTER TABLE request_cost_ledger ADD COLUMN usage_attributes TEXT NOT NULL DEFAULT '{}'; ALTER TABLE request_cost_ledger ADD COLUMN pricing_known INTEGER NOT NULL DEFAULT 1; ALTER TABLE request_cost_ledger ADD COLUMN pricing_snapshot TEXT;").execute(&mut db).await.unwrap();
    sqlx::query(
        "UPDATE provider_connections SET api_key = 'fixture-provider-key' WHERE id = 'test'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO api_keys (id,key) VALUES ('usage-client','usage-client-key-123456')")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('pricing','openrouter',?)")
        .bind(
            r#"{"vendor/gpt":{"input":2,"output":4,"cached":1,"cache_creation":2,"reasoning":4},"vendor/embed-priced":{"input":2,"output":0,"cached":2,"cache_creation":2,"reasoning":0}}"#,
        )
        .execute(&mut db)
        .await
        .unwrap();
    let (connection, key) =
        ProductConnection::open(&dir.path().join("storage.sqlite"), "test", None)
            .await
            .unwrap();
    let connection = connection.with_usage_accounting().await.unwrap();
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = upstream.local_addr().unwrap();
    let mode = Arc::new(AtomicUsize::new(0));
    let provider_mode = mode.clone();
    let provider = tokio::spawn(async move {
        axum::serve(upstream, Router::new().route("/v1/chat/completions", post(move |axum::Json(request): axum::Json<serde_json::Value>| {
            let mode = provider_mode.clone();
            async move {
                if request["model"]
                    .as_str()
                    .is_some_and(|model| model.starts_with("vendor/embed"))
                {
                    return axum::Json(serde_json::json!({
                        "object":"list",
                        "data":[{"object":"embedding","index":0,"embedding":[0.5]}],
                        "model":request["model"],
                        "usage":{"prompt_tokens":42,"total_tokens":42}
                    }))
                    .into_response();
                }
                if request["stream"] == true {
                    let usage = match mode.load(Ordering::SeqCst) {
                        1 => "data: {\"choices\":[]}\n\n",
                        2 => "data: {\"service_tier\":\"priority\",\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":50}}\n\n",
                        _ => "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":50}}\n\n",
                    };
                    let chunks = vec!["data: {\"choices\":[]}", "\n\n", usage, "data: [DONE]\n\n"];
                    let body = axum::body::Body::from_stream(stream::iter(chunks).then(|part| async move {
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                        Ok::<_, std::io::Error>(axum::body::Bytes::from_static(part.as_bytes()))
                    }));
                    return axum::http::Response::builder().header("content-type", "text/event-stream").body(body).unwrap();
                }
                let value = match mode.load(Ordering::SeqCst) {
                    1 => serde_json::json!({"id":"response"}),
                    2 => serde_json::json!({"id":"response", "service_tier":"priority", "usage":{"prompt_tokens":100,"completion_tokens":50}}),
                    _ => serde_json::json!({"id":"response", "usage":{"prompt_tokens":100,"completion_tokens":50}}),
                };
                axum::Json(value).into_response()
            }
        }))).await.unwrap()
    });
    let state = ProxyState::new(
        &format!("http://{address}/v1/chat/completions"),
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
    let proxy = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = |body: &'static str| {
        client
            .post(format!("http://{proxy}/v1/chat/completions"))
            .bearer_auth("usage-client-key-123456")
            .header("content-type", "application/json")
            .body(body)
    };
    assert_eq!(
        send(r#"{"model":"openrouter/vendor/gpt","messages":[]}"#)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let (count, cost): (i64, f64) = sqlx::query_as("SELECT count(*), sum(amount_usd) FROM request_cost_ledger WHERE api_key_id = 'usage-client'").fetch_one(&mut db).await.unwrap();
    assert_eq!(count, 1);
    assert!((cost - 0.0004).abs() < 1e-12);
    let tokens: f64 = sqlx::query_scalar("SELECT consumed FROM api_key_quota_counters WHERE api_key_id = 'usage-client' AND dimension_key = 'key-quota:tpm'").fetch_one(&mut db).await.unwrap();
    assert_eq!(tokens, 150.0);
    for unsupported in [1, 2] {
        mode.store(unsupported, Ordering::SeqCst);
        assert_eq!(
            send(r#"{"model":"openrouter/vendor/gpt","messages":[]}"#)
                .send()
                .await
                .unwrap()
                .status(),
            502
        );
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM request_cost_ledger WHERE api_key_id = 'usage-client'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(count, 1);
    mode.store(0, Ordering::SeqCst);
    assert_eq!(
        send(r#"{"model":"openrouter/vendor/gpt","messages":[],"stream":true}"#)
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    let streaming = r#"{"model":"openrouter/vendor/gpt","messages":[],"stream":true,"stream_options":{"include_usage":true}}"#;
    let stream_response = send(streaming).send().await.unwrap();
    assert_eq!(stream_response.status(), 200);
    let content = stream_response.text().await.unwrap();
    assert!(content.contains("[DONE]"));
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM request_cost_ledger WHERE api_key_id = 'usage-client'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(count, 2);
    mode.store(1, Ordering::SeqCst);
    let invalid_stream = send(streaming).send().await.unwrap();
    assert_eq!(invalid_stream.status(), 200);
    assert!(invalid_stream.bytes().await.is_err());
    mode.store(0, Ordering::SeqCst);
    let mut disconnected = send(streaming).send().await.unwrap();
    assert!(disconnected.chunk().await.unwrap().is_some());
    drop(disconnected);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM request_cost_ledger WHERE api_key_id = 'usage-client'",
            )
            .fetch_one(&mut db)
            .await
            .unwrap();
            if count == 3 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let uncertain: i64 = sqlx::query_scalar("SELECT count(*) FROM api_key_usage_reservations WHERE api_key_id = 'usage-client' AND state = 'dispatched'").fetch_one(&mut db).await.unwrap();
    assert_eq!(
        uncertain, 3,
        "responses without trustworthy usage must retain their reservations"
    );
    let labeled: i64 = sqlx::query_scalar("SELECT count(*) FROM api_key_usage_reservations WHERE api_key_id = 'usage-client' AND provider = 'openrouter' AND model = 'vendor/gpt' AND connection_id = 'test'").fetch_one(&mut db).await.unwrap();
    assert_eq!(labeled, 3);
    assert_eq!(
        send(r#"{"model":"openrouter/vendor/unknown","messages":[]}"#)
            .send()
            .await
            .unwrap()
            .status(),
        503
    );
    for (model, expected) in [("embed-priced", 200), ("embed-unpriced", 503)] {
        let response = client
            .post(format!("http://{proxy}/v1/embeddings"))
            .bearer_auth("usage-client-key-123456")
            .header("content-type", "application/json")
            .body(
                serde_json::json!({
                    "model":format!("openrouter/vendor/{model}"),
                    "input":"hello"
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected);
    }
    server.abort();

    let (connection, _) = ProductConnection::open(&dir.path().join("storage.sqlite"), "test", None)
        .await
        .unwrap();
    let connection = connection
        .with_usage_accounting()
        .await
        .unwrap()
        .with_all_usage_reporting()
        .unwrap();
    let state = ProxyState::new(
        &format!("http://{address}/v1/chat/completions"),
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
    let proxy = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let send = |body: &'static str| {
        client
            .post(format!("http://{proxy}/v1/chat/completions"))
            .bearer_auth("usage-client-key-123456")
            .header("content-type", "application/json")
            .body(body)
    };
    assert_eq!(
        send(r#"{"model":"openrouter/vendor/unknown","messages":[]}"#)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let unknown: (i64, f64, Option<String>, String) = sqlx::query_as(
        "SELECT pricing_known, amount_usd, pricing_snapshot, usage_attributes FROM request_cost_ledger WHERE api_key_id = 'usage-client' AND model = 'vendor/unknown'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(unknown, (0, 0.0, None, "{}".to_owned()));
    let unknown_stream = send(
        r#"{"model":"openrouter/vendor/unknown","messages":[],"stream":true,"stream_options":{"include_usage":true}}"#,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(unknown_stream.status(), 200);
    assert!(unknown_stream.text().await.unwrap().contains("[DONE]"));
    let unknown_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM request_cost_ledger WHERE api_key_id = 'usage-client' AND model = 'vendor/unknown' AND pricing_known = 0 AND pricing_snapshot IS NULL",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(unknown_count, 2);
    let response = client
        .post(format!("http://{proxy}/v1/embeddings"))
        .bearer_auth("usage-client-key-123456")
        .header("content-type", "application/json")
        .body(
            serde_json::json!({
                "model":"openrouter/vendor/embed-unpriced",
                "input":"hello"
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let response: serde_json::Value =
        serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    assert_eq!(response["data"][0]["embedding"][0], 0.5);
    let priced_embedding: (i64, i64, i64, f64, Option<String>) = sqlx::query_as(
        "SELECT tokens_input, tokens_output, pricing_known, amount_usd, pricing_snapshot FROM request_cost_ledger WHERE api_key_id = 'usage-client' AND model = 'vendor/embed-priced'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(priced_embedding.0, 42);
    assert_eq!(priced_embedding.1, 0);
    assert_eq!(priced_embedding.2, 1);
    assert!((priced_embedding.3 - 0.000084).abs() < 1e-12);
    assert!(priced_embedding.4.is_some());
    let unpriced_embedding: (i64, i64, i64, f64, Option<String>) = sqlx::query_as(
        "SELECT tokens_input, tokens_output, pricing_known, amount_usd, pricing_snapshot FROM request_cost_ledger WHERE api_key_id = 'usage-client' AND model = 'vendor/embed-unpriced'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(unpriced_embedding, (42, 0, 0, 0.0, None));
    sqlx::query("INSERT INTO api_key_quota_limits VALUES ('usage-client', 1000, NULL, NULL)")
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(
        send(r#"{"model":"openrouter/vendor/gpt","messages":[]}"#)
            .send()
            .await
            .unwrap()
            .status(),
        503
    );
    server.abort();
    provider.abort();
}

#[tokio::test]
async fn concurrent_direct_requests_share_reservations_with_typescript() {
    let (dir, mut db) = fixture().await;
    for migration in [
        include_str!("../../../src/lib/db/migrations/182_request_cost_ledger_and_key_quota.sql"),
        include_str!("../../../src/lib/db/migrations/219_cost_ledger_recovery.sql"),
        include_str!("../../../src/lib/db/migrations/226_shared_usage_reservations.sql"),
    ] {
        sqlx::raw_sql(migration).execute(&mut db).await.unwrap();
    }
    sqlx::raw_sql("ALTER TABLE request_cost_ledger ADD COLUMN tenant_id TEXT; ALTER TABLE request_cost_ledger ADD COLUMN usage_attributes TEXT NOT NULL DEFAULT '{}'; ALTER TABLE request_cost_ledger ADD COLUMN pricing_known INTEGER NOT NULL DEFAULT 1; ALTER TABLE request_cost_ledger ADD COLUMN pricing_snapshot TEXT;").execute(&mut db).await.unwrap();
    sqlx::query("UPDATE provider_connections SET api_key='provider-key' WHERE id='test'")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO api_keys (id,key) VALUES ('quota','concurrent-client-key-123456')")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO api_key_quota_limits VALUES ('quota',450,NULL,0.00120001)")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO api_key_daily_token_limits(api_key_id,daily_tokens_limit) VALUES ('quota',450)").execute(&mut db).await.unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('pricing','openrouter',?)")
        .bind(
            r#"{"vendor/gpt":{"input":2,"output":4,"cached":1,"cache_creation":2,"reasoning":4}}"#,
        )
        .execute(&mut db)
        .await
        .unwrap();
    let path = dir.path().join("storage.sqlite");
    let (connection, key) = ProductConnection::open(&path, "test", None).await.unwrap();
    let connection = connection
        .with_shared_rpm()
        .await
        .unwrap()
        .with_usage_accounting()
        .await
        .unwrap()
        .with_concurrent_strict_usage(150, 0.0004)
        .unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let provider = tokio::spawn({
        let entered = entered.clone();
        let release = release.clone();
        let calls = calls.clone();
        async move {
            axum::serve(upstream, Router::new().route("/v1/chat/completions", post(move || {
            let entered = entered.clone(); let release = release.clone(); let calls = calls.clone(); async move {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 { entered.notify_one(); release.notified().await; }
                axum::Json(serde_json::json!({"id":"ok","usage":{"prompt_tokens":100,"completion_tokens":50}}))
            }
        }))).await.unwrap()
        }
    });
    let state = ProxyState::new(
        &format!("http://{upstream_addr}/v1/chat/completions"),
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
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = || {
        client
            .post(format!("http://{address}/v1/chat/completions"))
            .bearer_auth("concurrent-client-key-123456")
            .header("content-type", "application/json")
            .body(r#"{"model":"openrouter/vendor/gpt","messages":[]}"#)
    };
    let first_request = send().build().unwrap();
    let first_client = client.clone();
    let first = tokio::spawn(async move { first_client.execute(first_request).await });
    tokio::time::timeout(Duration::from_secs(10), entered.notified())
        .await
        .expect("first request must reach provider");
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/concurrent-usage-node.mjs");
    let node = |action: &str| {
        let output = Command::new("node")
            .arg("--experimental-strip-types")
            .arg(&script)
            .arg(action)
            .env("RED_ROUTER_TEST_SQLITE", &path)
            .env("NODE_NO_WARNINGS", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "node fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"true");
    };
    node("reserve");
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), send().send())
            .await
            .unwrap()
            .unwrap()
            .status(),
        200
    );
    assert_eq!(send().send().await.unwrap().status(), 429);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    node("cancel");
    release.notify_one();
    assert_eq!(first.await.unwrap().unwrap().status(), 200);
    assert_eq!(send().send().await.unwrap().status(), 200);
    assert_eq!(send().send().await.unwrap().status(), 429);
    let (count, cost): (i64, f64) = sqlx::query_as(
        "SELECT COUNT(*), SUM(amount_usd) FROM request_cost_ledger WHERE api_key_id='quota'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(count, 3);
    assert!((cost - 0.0012).abs() < 1e-12);
    server.abort();
    provider.abort();
}

#[tokio::test]
async fn strict_usage_applies_product_limits_and_keeps_uncertain_attempts() {
    let (dir, mut db) = fixture().await;
    sqlx::raw_sql(include_str!(
        "../../../src/lib/db/migrations/182_request_cost_ledger_and_key_quota.sql"
    ))
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../src/lib/db/migrations/219_cost_ledger_recovery.sql"
    ))
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../src/lib/db/migrations/226_shared_usage_reservations.sql"
    ))
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::raw_sql("ALTER TABLE request_cost_ledger ADD COLUMN tenant_id TEXT; ALTER TABLE request_cost_ledger ADD COLUMN usage_attributes TEXT NOT NULL DEFAULT '{}'; ALTER TABLE request_cost_ledger ADD COLUMN pricing_known INTEGER NOT NULL DEFAULT 1; ALTER TABLE request_cost_ledger ADD COLUMN pricing_snapshot TEXT;").execute(&mut db).await.unwrap();
    sqlx::query("UPDATE provider_connections SET api_key='provider-key' WHERE id='test'")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO api_keys (id,key) VALUES ('quota','strict-client-key-123456'),('uncertain','uncertain-client-key-123'),('stream','stream-client-key-123456')").execute(&mut db).await.unwrap();
    sqlx::query("INSERT INTO api_key_quota_limits VALUES ('quota',300,NULL,0.0008),('uncertain',300,NULL,0.0008),('stream',150,NULL,0.0004)").execute(&mut db).await.unwrap();
    sqlx::query("INSERT INTO api_key_daily_token_limits(api_key_id,daily_tokens_limit) VALUES ('quota',300),('uncertain',300),('stream',150)").execute(&mut db).await.unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('pricing','openrouter',?)")
        .bind(
            r#"{"vendor/gpt":{"input":2,"output":4,"cached":1,"cache_creation":2,"reasoning":4}}"#,
        )
        .execute(&mut db)
        .await
        .unwrap();
    let (connection, key) =
        ProductConnection::open(&dir.path().join("storage.sqlite"), "test", None)
            .await
            .unwrap();
    let connection = connection
        .with_shared_rpm()
        .await
        .unwrap()
        .with_usage_accounting()
        .await
        .unwrap()
        .with_strict_usage(150, 0.0004)
        .unwrap();
    let (other_connection, other_key) =
        ProductConnection::open(&dir.path().join("storage.sqlite"), "test", None)
            .await
            .unwrap();
    let other_connection = other_connection
        .with_shared_rpm()
        .await
        .unwrap()
        .with_usage_accounting()
        .await
        .unwrap()
        .with_strict_usage(150, 0.0004)
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mode = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let provider_calls = calls.clone();
    let provider_mode = mode.clone();
    let provider_entered = entered.clone();
    let provider_release = release.clone();
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let provider = tokio::spawn(async move {
        axum::serve(upstream, Router::new().route("/v1/chat/completions", post(move |axum::Json(request): axum::Json<serde_json::Value>| {
        let calls = provider_calls.clone(); let mode = provider_mode.clone(); let entered = provider_entered.clone(); let release = provider_release.clone(); async move {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                entered.notify_one();
                release.notified().await;
            }
            if request["stream"] == true {
                return axum::http::Response::builder().header("content-type", "text/event-stream")
                    .body(axum::body::Body::from("data: {\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":50}}\n\ndata: [DONE]\n\n")).unwrap();
            }
            if mode.load(Ordering::SeqCst) == 1 { axum::Json(serde_json::json!({"id":"unknown"})).into_response() }
            else { axum::Json(serde_json::json!({"id":"ok","usage":{"prompt_tokens":100,"completion_tokens":50}})).into_response() }
        }
    }))).await.unwrap()
    });
    let state = ProxyState::new(
        &format!("http://{upstream_addr}/v1/chat/completions"),
        "unused-client-key-12345",
        &key,
        false,
    )
    .await
    .unwrap()
    .with_product_connection(connection)
    .with_product_client_keys()
    .unwrap();
    let other_state = ProxyState::new(
        &format!("http://{upstream_addr}/v1/chat/completions"),
        "unused-client-key-12345",
        &other_key,
        false,
    )
    .await
    .unwrap()
    .with_product_connection(other_connection)
    .with_product_client_keys()
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let other_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let other_address = other_listener.local_addr().unwrap();
    let other_server = tokio::spawn(async move {
        axum::serve(other_listener, router(other_state))
            .await
            .unwrap()
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = |key: &'static str| {
        client
            .post(format!("http://{address}/v1/chat/completions"))
            .bearer_auth(key)
            .header("content-type", "application/json")
            .body(r#"{"model":"openrouter/vendor/gpt","messages":[]}"#)
    };
    let first_request = send("strict-client-key-123456").build().unwrap();
    let first_client = client.clone();
    let first = tokio::spawn(async move { first_client.execute(first_request).await });
    tokio::time::timeout(std::time::Duration::from_secs(10), entered.notified())
        .await
        .expect("first request must reach provider");
    let second = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        client
            .post(format!("http://{other_address}/v1/chat/completions"))
            .bearer_auth("strict-client-key-123456")
            .header("content-type", "application/json")
            .body(r#"{"model":"openrouter/vendor/gpt","messages":[]}"#)
            .send(),
    )
    .await;
    release.notify_one();
    assert_eq!(
        second.expect("second request timed out").unwrap().status(),
        429
    );
    assert_eq!(first.await.unwrap().unwrap().status(), 200);
    assert_eq!(
        send("strict-client-key-123456")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        send("strict-client-key-123456")
            .send()
            .await
            .unwrap()
            .status(),
        429
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let (count, cost): (i64, f64) = sqlx::query_as(
        "SELECT count(*), sum(amount_usd) FROM request_cost_ledger WHERE api_key_id='quota'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(count, 2);
    assert!((cost - 0.0008).abs() < 1e-12);
    mode.store(1, Ordering::SeqCst);
    assert_eq!(
        send("uncertain-client-key-123")
            .send()
            .await
            .unwrap()
            .status(),
        502
    );
    mode.store(0, Ordering::SeqCst);
    assert_eq!(
        send("uncertain-client-key-123")
            .send()
            .await
            .unwrap()
            .status(),
        429
    );
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM api_key_usage_reservations WHERE api_key_id='uncertain' AND state='dispatched'").fetch_one(&mut db).await.unwrap();
    assert_eq!(pending, 1);
    let (pending_id, created): (String, i64) = sqlx::query_as(
        "SELECT id, created_at FROM api_key_usage_reservations WHERE api_key_id='uncertain'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    let list = Command::new(env!("CARGO_BIN_EXE_red-routerd"))
        .arg("list-usage-reservations")
        .env(
            "RED_ROUTER_PRODUCT_DB_PATH",
            dir.path().join("storage.sqlite"),
        )
        .output()
        .unwrap();
    assert!(list.status.success());
    let listed: serde_json::Value = serde_json::from_slice(&list.stdout).unwrap();
    assert!(listed["reservations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == pending_id && row["model"] == "vendor/gpt"));
    let refused = Command::new(env!("CARGO_BIN_EXE_red-routerd"))
        .arg("cancel-undispatched")
        .arg(&pending_id)
        .env(
            "RED_ROUTER_PRODUCT_DB_PATH",
            dir.path().join("storage.sqlite"),
        )
        .output()
        .unwrap();
    assert!(!refused.status.success());
    sqlx::query("UPDATE key_value SET value=? WHERE namespace='pricing' AND key='openrouter'").bind(r#"{"vendor/gpt":{"input":20,"output":40,"cached":10,"cache_creation":20,"reasoning":40}}"#).execute(&mut db).await.unwrap();
    let usage_path = dir.path().join("verified-usage.json");
    std::fs::write(&usage_path, serde_json::json!({"timestamp_ms":created+1,"usage":{"prompt_tokens":100,"completion_tokens":50}}).to_string()).unwrap();
    let reconciled = Command::new(env!("CARGO_BIN_EXE_red-routerd"))
        .arg("reconcile-usage")
        .arg(&pending_id)
        .arg(&usage_path)
        .env(
            "RED_ROUTER_PRODUCT_DB_PATH",
            dir.path().join("storage.sqlite"),
        )
        .output()
        .unwrap();
    assert!(
        reconciled.status.success(),
        "{}",
        String::from_utf8_lossy(&reconciled.stderr)
    );
    let recovered_cost: f64 =
        sqlx::query_scalar("SELECT amount_usd FROM request_cost_ledger WHERE event_id=?")
            .bind(&pending_id)
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert!(
        (recovered_cost - 0.0004).abs() < 1e-12,
        "reconciliation must use dispatch-time pricing"
    );
    sqlx::query("UPDATE key_value SET value=? WHERE namespace='pricing' AND key='openrouter'")
        .bind(
            r#"{"vendor/gpt":{"input":2,"output":4,"cached":1,"cache_creation":2,"reasoning":4}}"#,
        )
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(
        send("uncertain-client-key-123")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        send("uncertain-client-key-123")
            .send()
            .await
            .unwrap()
            .status(),
        429
    );
    let stream_request = || {
        client.post(format!("http://{address}/v1/chat/completions")).bearer_auth("stream-client-key-123456").header("content-type","application/json")
        .body(r#"{"model":"openrouter/vendor/gpt","messages":[],"stream":true,"stream_options":{"include_usage":true}}"#)
    };
    let response = stream_request().send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert!(response.text().await.unwrap().contains("[DONE]"));
    assert_eq!(stream_request().send().await.unwrap().status(), 429);
    let recorded: i64 =
        sqlx::query_scalar("SELECT count(*) FROM request_cost_ledger WHERE api_key_id='stream'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(recorded, 1);
    sqlx::query("INSERT INTO api_key_usage_reservations(id,api_key_id,reserved_tokens,reserved_usd,created_at,state) VALUES ('never-sent','stream',1,0.01,1700000000000,'reserved')").execute(&mut db).await.unwrap();
    let cancelled = Command::new(env!("CARGO_BIN_EXE_red-routerd"))
        .arg("cancel-undispatched")
        .arg("never-sent")
        .env(
            "RED_ROUTER_PRODUCT_DB_PATH",
            dir.path().join("storage.sqlite"),
        )
        .output()
        .unwrap();
    assert!(
        cancelled.status.success(),
        "{}",
        String::from_utf8_lossy(&cancelled.stderr)
    );
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM api_key_usage_reservations WHERE id='never-sent'")
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(remaining, 0);
    server.abort();
    other_server.abort();
    provider.abort();
}

#[tokio::test]
async fn automatic_fill_first_respects_priority_and_refuses_unsupported_state() {
    let (dir, mut db) = fixture().await;
    let path = dir.path().join("storage.sqlite");
    sqlx::query("UPDATE provider_connections SET priority = 20 WHERE id = 'test'")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO provider_connections (id,provider,auth_type,is_active,api_key,updated_at,priority) VALUES ('first','openrouter','apikey',1,'other-key','b',10)")
        .execute(&mut db).await.unwrap();
    assert_eq!(
        ProductConnection::select_fill_first(&path, "openrouter")
            .await
            .unwrap(),
        "first"
    );
    sqlx::query("UPDATE provider_connections SET is_active = 0 WHERE id = 'first'")
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(
        ProductConnection::select_fill_first(&path, "openrouter")
            .await
            .unwrap(),
        "test"
    );
    sqlx::query(
        "UPDATE provider_connections SET rate_limited_until = '2099-01-01' WHERE id = 'test'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    assert!(ProductConnection::select_fill_first(&path, "openrouter")
        .await
        .is_err());
    sqlx::query("UPDATE provider_connections SET rate_limited_until = NULL WHERE id = 'test'")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('settings','fallbackStrategy','\"round-robin\"')")
        .execute(&mut db)
        .await
        .unwrap();
    assert!(ProductConnection::select_fill_first(&path, "openrouter")
        .await
        .is_err());
    sqlx::query("INSERT INTO key_value VALUES ('settings','providerStrategies','{\"openrouter\":{\"fallbackStrategy\":\"fill-first\"}}')").execute(&mut db).await.unwrap();
    assert_eq!(
        ProductConnection::select_fill_first(&path, "openrouter")
            .await
            .unwrap(),
        "test"
    );
    let (connection, _) = ProductConnection::open(&path, "test", Some("fixture-password"))
        .await
        .unwrap();
    let connection = connection.with_auto_selection_guard();
    assert!(connection.unchanged().await);
    sqlx::query("INSERT INTO provider_quota_state VALUES ('test')")
        .execute(&mut db)
        .await
        .unwrap();
    assert!(ProductConnection::select_fill_first(&path, "openrouter")
        .await
        .is_err());
    assert!(!connection.unchanged().await);
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
            "INSERT INTO api_key_daily_token_limits (api_key_id) VALUES ('client')",
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
            "INSERT INTO combos (name) VALUES ('openrouter/openai/gpt')",
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
async fn dashboard_combo_enforces_key_and_connection_restrictions_across_providers() {
    let (dir, mut db) = fixture().await;
    sqlx::query(
        "UPDATE provider_connections SET api_key = 'router-key', priority = 1 WHERE id = 'test'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO provider_connections (id,provider,auth_type,is_active,api_key,updated_at,priority) VALUES ('openai1','openai','apikey',1,'openai-key','b',1)").execute(&mut db).await.unwrap();
    let data = serde_json::json!({"name":"mix","strategy":"priority","version":2,"config":{},
        "models":[{"id":"a","kind":"model","model":"openrouter/vendor/gpt","providerId":"openrouter","weight":0},
        {"id":"b","kind":"model","model":"openai/gpt","providerId":"openai","weight":0}]}).to_string();
    sqlx::query("INSERT INTO combos (name,data) VALUES ('mix',?)")
        .bind(&data)
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO api_keys (id,key,model_access_mode,allowed_models,allowed_combos,allowed_connections) VALUES ('combo-client','dashboard-combo-key-12345','restricted','[\"openrouter/*\",\"openai/*\"]','[\"mix\"]','[\"test\",\"openai1\"]')").execute(&mut db).await.unwrap();
    sqlx::query("INSERT INTO api_key_quota_limits VALUES ('combo-client',NULL,20,NULL)")
        .execute(&mut db)
        .await
        .unwrap();
    let path = dir.path().join("storage.sqlite");
    let combo = ProductCombo::load(&path, "mix").await.unwrap();
    let (primary, primary_key) = ProductConnection::open(&path, "test", None).await.unwrap();
    let primary = primary
        .with_auto_selection_guard()
        .with_shared_rpm()
        .await
        .unwrap();
    let (secondary, _) = ProductConnection::open(&path, "openai1", None)
        .await
        .unwrap();
    let secondary = secondary
        .with_auto_selection_guard()
        .inherit_accounting(&primary)
        .unwrap();
    let calls = Arc::new([AtomicUsize::new(0), AtomicUsize::new(0)]);
    let seen = calls.clone();
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let provider = tokio::spawn(async move {
        axum::serve(
            upstream,
            Router::new().route(
                "/v1/chat/completions",
                post(
                    move |headers: axum::http::HeaderMap,
                          axum::Json(body): axum::Json<serde_json::Value>| {
                        let seen = seen.clone();
                        async move {
                            match headers.get("authorization").and_then(|v| v.to_str().ok()) {
                                Some("Bearer router-key") => {
                                    assert_eq!(body["model"], "vendor/gpt");
                                    seen[0].fetch_add(1, Ordering::SeqCst);
                                    axum::http::StatusCode::TOO_MANY_REQUESTS
                                }
                                Some("Bearer openai-key") => {
                                    assert_eq!(body["model"], "gpt");
                                    seen[1].fetch_add(1, Ordering::SeqCst);
                                    axum::http::StatusCode::OK
                                }
                                _ => axum::http::StatusCode::UNAUTHORIZED,
                            }
                        }
                    },
                ),
            ),
        )
        .await
        .unwrap()
    });
    let routes = serde_json::json!([{"model":"mix","fallback":true,"targets":[
        {"url":format!("http://{upstream_addr}/v1/chat/completions"),"model":"vendor/gpt","api_key_env":"ROUTER"},
        {"url":format!("http://{upstream_addr}/v1/chat/completions"),"model":"gpt","api_key_env":"OPENAI"}
    ]}]).to_string();
    let state = ProxyState::new(
        &format!("http://{upstream_addr}/v1/chat/completions"),
        "unused-client-key-12345",
        &primary_key,
        false,
    )
    .await
    .unwrap()
    .with_routes(
        &routes,
        |name| match name {
            "ROUTER" => Some("router-key".into()),
            "OPENAI" => Some("openai-key".into()),
            _ => None,
        },
        false,
    )
    .await
    .unwrap()
    .with_product_connection(primary.clone())
    .with_product_combo(combo, vec![primary, secondary])
    .unwrap()
    .with_product_client_keys()
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = || {
        client
            .post(format!("http://{addr}/v1/chat/completions"))
            .bearer_auth("dashboard-combo-key-12345")
            .header("content-type", "application/json")
            .body(r#"{"model":"mix","messages":[]}"#)
    };
    assert_eq!(send().send().await.unwrap().status(), 200);
    assert_eq!(calls[0].load(Ordering::SeqCst), 1);
    assert_eq!(calls[1].load(Ordering::SeqCst), 1);
    let total: f64 = sqlx::query_scalar("SELECT CAST(SUM(consumed) AS REAL) FROM api_key_quota_counters WHERE api_key_id = 'combo-client'")
        .fetch_one(&mut db).await.unwrap();
    assert_eq!(total, 1.0);
    sqlx::query(
        "UPDATE api_keys SET allowed_connections = '[\"openai1\"]' WHERE id = 'combo-client'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    assert_eq!(send().send().await.unwrap().status(), 200);
    assert_eq!(calls[0].load(Ordering::SeqCst), 1);
    assert_eq!(calls[1].load(Ordering::SeqCst), 2);
    sqlx::query("UPDATE api_keys SET allowed_combos = '[]' WHERE id = 'combo-client'")
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(send().send().await.unwrap().status(), 401);
    sqlx::query("UPDATE api_keys SET allowed_combos = '[\"mix\"]' WHERE id = 'combo-client'")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("UPDATE combos SET data = '{\"changed\":true}' WHERE name = 'mix'")
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(send().send().await.unwrap().status(), 503);
    server.abort();
    provider.abort();
}

#[tokio::test]
async fn typescript_and_rust_share_rpm_admission() {
    let (dir, mut db) = fixture().await;
    sqlx::query(
        "UPDATE provider_connections SET api_key = 'fixture-provider-key' WHERE id = 'test'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO api_keys (id,key) VALUES ('mixed-client','mixed-dashboard-key-12345')",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO api_key_quota_limits VALUES ('mixed-client',NULL,8,NULL)")
        .execute(&mut db)
        .await
        .unwrap();
    let (connection, key) =
        ProductConnection::open(&dir.path().join("storage.sqlite"), "test", None)
            .await
            .unwrap();
    let connection = connection.with_shared_rpm().await.unwrap();
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
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/shared-rpm-node.mjs");
    let mut node = Command::new("node")
        .arg("--experimental-strip-types")
        .arg(fixture)
        .env("RED_ROUTER_TEST_SQLITE", dir.path().join("storage.sqlite"))
        .env("NODE_NO_WARNINGS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = std::io::BufReader::new(node.stdout.take().unwrap());
    let mut ready = String::new();
    stdout.read_line(&mut ready).unwrap();
    assert_eq!(ready.trim(), "ready");
    // Both implementations use the current minute; avoid a rollover mid-test.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    if now % 60_000 > 55_000 {
        tokio::time::sleep(std::time::Duration::from_millis(60_050 - now % 60_000)).await;
    }
    node.stdin.take().unwrap().write_all(b"go\n").unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let statuses: Vec<_> = stream::iter(0..16)
        .map(|_| {
            let client = client.clone();
            async move {
                client
                    .post(format!("http://{address}/v1/chat/completions"))
                    .bearer_auth("mixed-dashboard-key-12345")
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
    let status = node.wait().unwrap();
    assert!(status.success());
    let mut output = String::new();
    stdout.read_to_string(&mut output).unwrap();
    let result: serde_json::Value = serde_json::from_str(&output).unwrap();
    let node_allowed = result["allowed"].as_u64().unwrap() as usize;
    let rust_allowed = statuses.iter().filter(|s| **s == 200).count();
    assert_eq!(rust_allowed + node_allowed, 8, "{statuses:?}: {output}");
    assert!(
        statuses.iter().all(|s| *s == 200 || *s == 429),
        "{statuses:?}"
    );
    let total: f64 = sqlx::query_scalar("SELECT CAST(SUM(consumed) AS REAL) FROM api_key_quota_counters WHERE api_key_id = 'mixed-client'")
        .fetch_one(&mut db).await.unwrap();
    assert_eq!(total, 8.0);
    server.abort();
    provider.abort();
}

#[tokio::test]
async fn same_provider_fallback_honors_connection_policy_and_reserves_rpm_once() {
    let (dir, mut db) = fixture().await;
    sqlx::query(
        "UPDATE provider_connections SET api_key = 'first-key', priority = 1 WHERE id = 'test'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO provider_connections (id,provider,auth_type,is_active,api_key,updated_at,priority) VALUES ('second','openrouter','apikey',1,'second-key','b',2)")
        .execute(&mut db).await.unwrap();
    sqlx::query("INSERT INTO api_keys (id,key,allowed_connections) VALUES ('client','dashboard-fallback-key-12345','[\"test\",\"second\"]')")
        .execute(&mut db).await.unwrap();
    sqlx::query("INSERT INTO api_key_quota_limits VALUES ('client',NULL,1,NULL)")
        .execute(&mut db)
        .await
        .unwrap();
    let path = dir.path().join("storage.sqlite");
    let (primary, primary_key) = ProductConnection::open(&path, "test", None).await.unwrap();
    let primary = primary
        .with_auto_selection_guard()
        .with_shared_rpm()
        .await
        .unwrap();
    assert_eq!(primary.fallback_ids().await.unwrap(), vec!["second"]);
    let (secondary, secondary_key) = ProductConnection::open(&path, "second", None)
        .await
        .unwrap();
    let secondary = secondary.inherit_accounting(&primary).unwrap();
    let first_count = Arc::new(AtomicUsize::new(0));
    let second_count = Arc::new(AtomicUsize::new(0));
    let first_seen = first_count.clone();
    let second_seen = second_count.clone();
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_address = upstream.local_addr().unwrap();
    let provider = tokio::spawn(async move {
        axum::serve(
            upstream,
            Router::new().route(
                "/v1/chat/completions",
                post(move |headers: axum::http::HeaderMap| {
                    let first_seen = first_seen.clone();
                    let second_seen = second_seen.clone();
                    async move {
                        match headers.get("authorization").and_then(|v| v.to_str().ok()) {
                            Some("Bearer first-key") => {
                                first_seen.fetch_add(1, Ordering::SeqCst);
                                axum::http::StatusCode::TOO_MANY_REQUESTS
                            }
                            Some("Bearer second-key") => {
                                second_seen.fetch_add(1, Ordering::SeqCst);
                                axum::http::StatusCode::OK
                            }
                            _ => axum::http::StatusCode::UNAUTHORIZED,
                        }
                    }
                }),
            ),
        )
        .await
        .unwrap()
    });
    let state = ProxyState::new(
        &format!("http://{upstream_address}/v1/chat/completions"),
        "unused-client-key-12345",
        &primary_key,
        false,
    )
    .await
    .unwrap()
    .with_product_connection(primary)
    .with_product_client_keys()
    .unwrap()
    .with_product_fallbacks(vec![(secondary, secondary_key.to_string())])
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = || {
        client
            .post(format!("http://{address}/v1/chat/completions"))
            .bearer_auth("dashboard-fallback-key-12345")
            .header("content-type", "application/json")
            .body(r#"{"model":"openrouter/openai/gpt","messages":[]}"#)
    };
    assert_eq!(send().send().await.unwrap().status(), 200);
    assert_eq!(first_count.load(Ordering::SeqCst), 1);
    assert_eq!(second_count.load(Ordering::SeqCst), 1);
    let total: f64 = sqlx::query_scalar(
        "SELECT SUM(consumed) FROM api_key_quota_counters WHERE api_key_id = 'client'",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(total, 1.0);
    assert_eq!(send().send().await.unwrap().status(), 429);
    sqlx::query("DELETE FROM api_key_quota_counters")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("UPDATE api_keys SET allowed_connections = '[\"test\"]' WHERE id = 'client'")
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(send().send().await.unwrap().status(), 429);
    assert_eq!(first_count.load(Ordering::SeqCst), 2);
    assert_eq!(second_count.load(Ordering::SeqCst), 1);
    sqlx::query("DELETE FROM api_key_quota_counters")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("UPDATE api_keys SET allowed_connections = '[\"second\"]' WHERE id = 'client'")
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(send().send().await.unwrap().status(), 200);
    assert_eq!(first_count.load(Ordering::SeqCst), 2);
    assert_eq!(second_count.load(Ordering::SeqCst), 2);
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
    assert_eq!(
        statuses.iter().filter(|s| **s == 200).count(),
        4,
        "{statuses:?}"
    );
    assert_eq!(
        statuses.iter().filter(|s| **s == 429).count(),
        12,
        "{statuses:?}"
    );
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
    // Match the product database's normal journal mode; functional concurrency
    // tests also exercise SQLite's default rollback journal separately.
    sqlx::query("PRAGMA journal_mode = WAL")
        .execute(&mut db)
        .await
        .unwrap();
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
            "{label}: journal=wal n={} concurrency=16 p50={}us p95={}us",
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

async fn measure_quota_aware_control_plane() {
    const ADMIN: &str = "quota-benchmark-admin-key-1234567890";
    const STORAGE: &str = "quota-benchmark-storage-key-123456";
    const CLIENT: &str = "quota-benchmark-client-key-1234567";
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("quota-routing.sqlite")).unwrap();
    let database_url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(
        Database::connect(Backend::Sqlite, &database_url)
            .await
            .unwrap(),
    );
    let control = ControlPlane::new(database.clone(), ADMIN, STORAGE, false)
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
    let state = ProxyState::new(
        "http://127.0.0.1:1/v1/chat/completions",
        "quota-placeholder-client-key",
        "quota-placeholder-provider-key",
        true,
    )
    .await
    .unwrap()
    .with_control_plane(control);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = format!("http://{address}");
    for (id, api_key) in [("quota-first", "first-key"), ("quota-second", "second-key")] {
        let response = client
            .put(format!("{base}/api/admin/providers/{id}"))
            .bearer_auth(ADMIN)
            .header("content-type", "application/json")
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
            .unwrap();
        assert_eq!(response.status(), 200);
    }
    let response = client
        .put(format!("{base}/api/admin/client-keys/quota-benchmark"))
        .bearer_auth(ADMIN)
        .header("content-type", "application/json")
        .body(
            serde_json::json!({
                "label":"Quota benchmark",
                "api_key":CLIENT,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["quota-combo","upstream-model"],
                "allowed_provider_ids":["quota-first","quota-second"]
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    for (id, session, weekly) in [("quota-first", 90.0, 80.0), ("quota-second", 65.0, 55.0)] {
        let response = client
            .put(format!("{base}/api/admin/provider-quotas/{id}"))
            .bearer_auth(ADMIN)
            .header("content-type", "application/json")
            .body(
                serde_json::json!({
                    "session":{"remaining_percent":session},
                    "weekly":{"remaining_percent":weekly},
                    "ttl_seconds":600
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
    }
    let response = client
        .put(format!("{base}/api/admin/combos/quota-combo"))
        .bearer_auth(ADMIN)
        .header("content-type", "application/json")
        .body(
            serde_json::json!({
                "strategy":"quota-weighted",
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
        .unwrap();
    assert_eq!(response.status(), 200);
    let samples: Vec<u128> = stream::iter(0..220)
        .map(|_| {
            let client = client.clone();
            let url = format!("{base}/v1/chat/completions");
            async move {
                let start = std::time::Instant::now();
                let response = client
                    .post(url)
                    .bearer_auth(CLIENT)
                    .header("content-type", "application/json")
                    .body(r#"{"model":"quota-combo","messages":[]}"#)
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
        "quota-weighted-control: journal=wal n={} concurrency=16 p50={}us p95={}us",
        measured.len(),
        measured[measured.len() / 2],
        measured[measured.len() * 95 / 100]
    );
    server.abort();
    provider.abort();
    database.close().await.unwrap();
}

// Measures the real dashboard combo/policy path with both a healthy first
// provider and a 429 fallback, against loopback mocks on the same runner.
#[tokio::test]
#[ignore = "run explicitly in release mode for descriptive performance"]
async fn benchmark_dashboard_combo() {
    let (dir, mut db) = fixture().await;
    sqlx::query("PRAGMA journal_mode = WAL")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE provider_connections SET api_key = 'router-key', priority = 1 WHERE id = 'test'",
    )
    .execute(&mut db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO provider_connections (id,provider,auth_type,is_active,api_key,updated_at,priority) VALUES ('openai1','openai','apikey',1,'openai-key','b',1)").execute(&mut db).await.unwrap();
    let data = serde_json::json!({"name":"mix","strategy":"priority","models":["openrouter/vendor/gpt","openai/gpt"]}).to_string();
    sqlx::query("INSERT INTO combos (name,data) VALUES ('mix',?)")
        .bind(data)
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO api_keys (id,key,allowed_combos) VALUES ('bench-combo','dashboard-combo-key-12345','[\"mix\"]')").execute(&mut db).await.unwrap();
    let path = dir.path().join("storage.sqlite");
    let combo = ProductCombo::load(&path, "mix").await.unwrap();
    let (primary, primary_key) = ProductConnection::open(&path, "test", None).await.unwrap();
    let primary = primary
        .with_auto_selection_guard()
        .with_shared_rpm()
        .await
        .unwrap();
    let (secondary, _) = ProductConnection::open(&path, "openai1", None)
        .await
        .unwrap();
    let secondary = secondary
        .with_auto_selection_guard()
        .inherit_accounting(&primary)
        .unwrap();
    let fallback = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = fallback.clone();
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let provider = tokio::spawn(async move {
        axum::serve(
            upstream,
            Router::new().route(
                "/v1/chat/completions",
                post(move |headers: axum::http::HeaderMap| {
                    let flag = flag.clone();
                    async move {
                        if flag.load(Ordering::Relaxed)
                            && headers.get("authorization").and_then(|v| v.to_str().ok())
                                == Some("Bearer router-key")
                        {
                            axum::http::StatusCode::TOO_MANY_REQUESTS
                        } else {
                            axum::http::StatusCode::OK
                        }
                    }
                }),
            ),
        )
        .await
        .unwrap()
    });
    let upstream_url = format!("http://{upstream_addr}/v1/chat/completions");
    let routes = serde_json::json!([{"model":"mix","fallback":true,"targets":[
        {"url":upstream_url,"model":"vendor/gpt","api_key_env":"ROUTER"},
        {"url":upstream_url,"model":"gpt","api_key_env":"OPENAI"}
    ]}])
    .to_string();
    let state = ProxyState::new(
        &upstream_url,
        "unused-client-key-12345",
        &primary_key,
        false,
    )
    .await
    .unwrap()
    .with_routes(
        &routes,
        |name| match name {
            "ROUTER" => Some("router-key".into()),
            "OPENAI" => Some("openai-key".into()),
            _ => None,
        },
        false,
    )
    .await
    .unwrap()
    .with_product_connection(primary.clone())
    .with_product_combo(combo, vec![primary, secondary])
    .unwrap()
    .with_product_client_keys()
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let url = format!("http://{address}/v1/chat/completions");
    for (label, use_fallback) in [
        ("dashboard-combo-primary", false),
        ("dashboard-combo-fallback", true),
    ] {
        fallback.store(use_fallback, Ordering::Relaxed);
        let samples: Vec<u128> = stream::iter(0..220)
            .map(|_| {
                let client = client.clone();
                let url = url.clone();
                async move {
                    let start = std::time::Instant::now();
                    let response = client
                        .post(url)
                        .bearer_auth("dashboard-combo-key-12345")
                        .header("content-type", "application/json")
                        .body(r#"{"model":"mix","messages":[]}"#)
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
            "{label}: journal=wal n={} concurrency=16 p50={}us p95={}us",
            measured.len(),
            measured[measured.len() / 2],
            measured[measured.len() * 95 / 100]
        );
    }
    server.abort();
    provider.abort();
    measure_quota_aware_control_plane().await;
}
