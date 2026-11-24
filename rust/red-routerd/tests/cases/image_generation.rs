// An OpenRouter chat account serves /v1/images/generations at the sibling
// images endpoint with its Bearer key (legacy imageRegistry `openrouter`), the
// upstream body keeps only the legacy fields and the answer is reduced to
// {created, data}.
#[tokio::test]
async fn an_openrouter_account_serves_image_generation_at_its_images_endpoint() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("images.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let seen = Arc::new(Mutex::new(Vec::<(Option<String>, serde_json::Value)>::new()));
    let observed = seen.clone();
    let app = Router::new().route(
        "/api/v1/images/generations",
        post(move |headers: HeaderMap, body: String| {
            let observed = observed.clone();
            async move {
                let body: serde_json::Value = serde_json::from_str(&body).unwrap();
                let empty = body["prompt"] == "return nothing";
                observed.lock().unwrap().push((
                    headers
                        .get(header::AUTHORIZATION)
                        .map(|value| value.to_str().unwrap().to_owned()),
                    body,
                ));
                if empty {
                    return Json(serde_json::json!({"created":1,"data":[]}));
                }
                Json(serde_json::json!({
                    "created":0,
                    "data":[{"b64_json":"AAAA","revised_prompt":"a red fox"}],
                    "usage":{"total_tokens":3}
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/or"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"openrouter",
                "upstream_url":format!("http://{address}/api/v1/chat/completions"),
                "api_key":"or-secret"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let image_key = "image-client-key-12345678901234567890";
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/image-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Image client","api_key":image_key,
                "scopes":["inference:images"],"allowed_endpoints":["images"],
                "allowed_models":["openrouter/black-forest-labs/flux.2-pro"],
                "allowed_provider_ids":["or"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let generate = |body: serde_json::Value| {
        client
            .post(format!("{base}/v1/images/generations"))
            .bearer_auth(image_key)
            .json(&body)
            .send()
    };
    let response = generate(serde_json::json!({
        "model":"openrouter/black-forest-labs/flux.2-pro","prompt":"a red fox",
        "n":1,"size":"1024x1024","user":"someone","seed":7
    }))
    .await
    .unwrap();
    let status = response.status();
    let text = response.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{text}");
    let answer: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert!(
        answer["created"].as_u64().unwrap() > 1_000_000_000,
        "{text}"
    );
    assert_eq!(
        answer["data"],
        serde_json::json!([{"b64_json":"AAAA","revised_prompt":"a red fox"}])
    );
    assert!(answer.get("usage").is_none(), "{text}");

    // A blank prompt never reaches the upstream.
    let blank = generate(serde_json::json!({
        "model":"openrouter/black-forest-labs/flux.2-pro","prompt":"  "
    }))
    .await
    .unwrap();
    assert_eq!(blank.status(), StatusCode::BAD_REQUEST);
    assert!(blank
        .text()
        .await
        .unwrap()
        .contains("Prompt is required for image model: openrouter/black-forest-labs/flux.2-pro"));

    // A 2xx answer without an image is a retryable 502.
    let empty = generate(serde_json::json!({
        "model":"openrouter/black-forest-labs/flux.2-pro","prompt":"return nothing"
    }))
    .await
    .unwrap();
    assert_eq!(empty.status(), StatusCode::BAD_GATEWAY);

    // A key without the images endpoint is refused.
    assert_eq!(
        client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth(image_key)
            .json(&serde_json::json!({
                "model":"openrouter/black-forest-labs/flux.2-pro",
                "messages":[{"role":"user","content":"hi"}]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );

    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].0.as_deref(), Some("Bearer or-secret"));
    assert_eq!(
        seen[0].1,
        serde_json::json!({
            "model":"black-forest-labs/flux.2-pro","prompt":"a red fox",
            "n":1,"size":"1024x1024"
        })
    );
    gateway_task.abort();
    provider_task.abort();
    database.close().await.unwrap();
}

// A Cloudflare Workers AI account serves image generation at `ai/run/<model>`
// (legacy `cloudflare-ai-image`): the size is split into width and height and
// the raw base64 result becomes `data[0].b64_json`.
#[tokio::test]
async fn a_cloudflare_account_serves_image_generation_through_ai_run() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("cloudflare-images.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let seen = Arc::new(Mutex::new(Vec::<(Option<String>, serde_json::Value)>::new()));
    let observed = seen.clone();
    let app = Router::new().route(
        "/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/black-forest-labs/flux-1-schnell",
        post(move |headers: HeaderMap, body: String| {
            let observed = observed.clone();
            async move {
                observed.lock().unwrap().push((
                    headers
                        .get(header::AUTHORIZATION)
                        .map(|value| value.to_str().unwrap().to_owned()),
                    serde_json::from_str(&body).unwrap(),
                ));
                Json(serde_json::json!({
                    "result":{"image":"QUJD"},"success":true,"errors":[],"messages":[]
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let provider_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        client
            .put(format!("{base}/api/admin/providers/cf"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "provider":"cloudflare-ai",
                "upstream_url":format!("http://{address}/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions"),
                "api_key":"cf-secret"
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let image_key = "cloudflare-image-key-1234567890123456789";
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/cf-image"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Cloudflare image","api_key":image_key,
                "scopes":["inference:images"],"allowed_endpoints":["images"],
                "allowed_models":["cloudflare-ai/@cf/black-forest-labs/flux-1-schnell"],
                "allowed_provider_ids":["cf"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let response = client
        .post(format!("{base}/v1/images/generations"))
        .bearer_auth(image_key)
        .json(&serde_json::json!({
            "model":"cloudflare-ai/@cf/black-forest-labs/flux-1-schnell",
            "prompt":"a red fox","size":"1024x768","seed":7,"n":3
        }))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let text = response.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{text}");
    let answer: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        answer["data"],
        serde_json::json!([{"b64_json":"QUJD","revised_prompt":"a red fox"}])
    );
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0.as_deref(), Some("Bearer cf-secret"));
    assert_eq!(
        seen[0].1,
        serde_json::json!({"prompt":"a red fox","width":1024,"height":768,"seed":7})
    );
    gateway_task.abort();
    provider_task.abort();
    database.close().await.unwrap();
}
