// An OpenRouter account transcribes at its sibling `audio/transcriptions`
// endpoint (legacy `openrouter-stt`): the Whisper-style multipart upload is
// forwarded as JSON with a base64 `input_audio`, and the answer passes through.
#[tokio::test]
async fn an_openrouter_account_transcribes_a_multipart_upload() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("transcriptions.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let seen = Arc::new(Mutex::new(Vec::<(Option<String>, serde_json::Value)>::new()));
    let observed = seen.clone();
    let app = Router::new().route(
        "/api/v1/audio/transcriptions",
        post(move |headers: HeaderMap, body: String| {
            let observed = observed.clone();
            async move {
                observed.lock().unwrap().push((
                    headers
                        .get(header::AUTHORIZATION)
                        .map(|value| value.to_str().unwrap().to_owned()),
                    serde_json::from_str(&body).unwrap(),
                ));
                Json(serde_json::json!({"text":"hello world","usage":{"seconds":1}}))
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
    let audio_key = "audio-client-key-1234567890123456789012";
    assert_eq!(
        client
            .put(format!("{base}/api/admin/client-keys/audio-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Audio client","api_key":audio_key,
                "scopes":["inference:audio"],"allowed_endpoints":["audio"],
                "allowed_models":["openrouter/openai/whisper-1"],
                "allowed_provider_ids":["or"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let form = |parts: &[(&str, Option<&str>, &[u8])]| {
        let mut body = Vec::new();
        for (name, file_name, content) in parts {
            body.extend_from_slice(b"--stt-boundary\r\n");
            match file_name {
                Some(file_name) => body.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{file_name}\"\r\nContent-Type: audio/mpeg\r\n\r\n"
                    )
                    .as_bytes(),
                ),
                None => body.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
                ),
            }
            body.extend_from_slice(content);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(b"--stt-boundary--\r\n");
        body
    };
    let transcribe = |body: Vec<u8>| {
        client
            .post(format!("{base}/v1/audio/transcriptions"))
            .bearer_auth(audio_key)
            .header(
                header::CONTENT_TYPE,
                "multipart/form-data; boundary=stt-boundary",
            )
            .body(body)
            .send()
    };
    let response = transcribe(form(&[
        ("model", None, b"openrouter/openai/whisper-1"),
        ("language", None, b"en"),
        ("temperature", None, b"0.3"),
        ("file", Some("clip.mp3"), b"ID3audio"),
    ]))
    .await
    .unwrap();
    let status = response.status();
    let text = response.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&text).unwrap()["text"],
        "hello world"
    );

    // A missing file or model never reaches the upstream.
    let no_file = transcribe(form(&[("model", None, b"openrouter/openai/whisper-1")]))
        .await
        .unwrap();
    assert_eq!(no_file.status(), StatusCode::BAD_REQUEST);
    assert!(no_file.text().await.unwrap().contains("file is required"));

    // A key without the audio endpoint is refused.
    assert_eq!(
        client
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth(audio_key)
            .json(&serde_json::json!({
                "model":"openrouter/openai/whisper-1",
                "messages":[{"role":"user","content":"hi"}]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );

    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0.as_deref(), Some("Bearer or-secret"));
    assert_eq!(
        seen[0].1,
        serde_json::json!({
            "model":"openai/whisper-1",
            "input_audio":{"data":"SUQzYXVkaW8=","format":"mp3"},
            "language":"en","temperature":0.3
        })
    );
    gateway_task.abort();
    provider_task.abort();
    database.close().await.unwrap();
}
