// Legacy `POST /api/keys/{id}/regenerate`: a server-generated secret replaces the
// key's hash, the old secret stops working at once, and a management key of
// another tenant can neither rotate nor revoke it.
#[tokio::test]
async fn client_keys_rotate_and_revoke_within_their_tenant_only() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("rotation.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database.clone(), ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        client
            .put(format!("{base}/api/admin/tenants/acme"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({"slug":"acme","name":"Acme"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let issue = |body: serde_json::Value| {
        let client = client.clone();
        let base = base.clone();
        async move {
            let response = client
                .post(format!("{base}/api/admin/client-keys"))
                .bearer_auth(ADMIN_KEY)
                .json(&body)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CREATED);
            let body: serde_json::Value = response.json().await.unwrap();
            (
                body["client_key"]["id"].as_str().unwrap().to_owned(),
                body["key"].as_str().unwrap().to_owned(),
            )
        }
    };
    let (red_id, red_secret) =
        issue(serde_json::json!({"label":"Red chat","scopes":["inference:chat"]})).await;
    let (acme_id, acme_secret) = issue(serde_json::json!({
        "label":"Acme chat","tenant_id":"acme","scopes":["inference:chat"]
    }))
    .await;
    let (_, acme_manager) = issue(serde_json::json!({
        "label":"Acme manager","tenant_id":"acme","scopes":["manage"]
    }))
    .await;
    let accepted = |secret: String| {
        let client = client.clone();
        let base = base.clone();
        async move {
            client
                .get(format!("{base}/v1/key"))
                .bearer_auth(secret)
                .send()
                .await
                .unwrap()
                .status()
                == StatusCode::OK
        }
    };
    assert!(accepted(red_secret.clone()).await);
    assert!(accepted(acme_secret.clone()).await);

    // Another tenant's management key cannot touch the default tenant's key.
    let foreign_rotate = client
        .post(format!("{base}/api/admin/client-keys/{red_id}/rotate"))
        .bearer_auth(&acme_manager)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign_rotate.status(), StatusCode::NOT_FOUND);
    let foreign_revoke = client
        .delete(format!("{base}/api/admin/client-keys/{red_id}"))
        .bearer_auth(&acme_manager)
        .send()
        .await
        .unwrap();
    assert!(!foreign_revoke.status().is_success());
    assert!(accepted(red_secret.clone()).await);

    // Rotating its own key gives a new secret once and retires the old one.
    let rotated = client
        .post(format!("{base}/api/admin/client-keys/{acme_id}/rotate"))
        .bearer_auth(&acme_manager)
        .send()
        .await
        .unwrap();
    assert_eq!(rotated.status(), StatusCode::OK);
    assert_eq!(rotated.headers()[header::CACHE_CONTROL], "no-store");
    let rotated: serde_json::Value = rotated.json().await.unwrap();
    let new_secret = rotated["key"].as_str().unwrap().to_owned();
    assert!(new_secret.starts_with("rrk_"));
    assert_ne!(new_secret, acme_secret);
    assert_eq!(rotated["client_key"]["id"], acme_id.as_str());
    assert_eq!(rotated["client_key"]["label"], "Acme chat");
    assert!(!accepted(acme_secret.clone()).await);
    assert!(accepted(new_secret.clone()).await);
    let stored = database.client_keys().await.unwrap();
    assert!(!format!("{stored:?}").contains(&new_secret));
    let audit: serde_json::Value = client
        .get(format!(
            "{base}/api/compliance/audit-log?action=client_key.rotate"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(audit.to_string().contains("client_key.rotate"), "{audit}");
    assert!(!audit.to_string().contains(&new_secret));

    // Revoking its own key retires the rotated secret too.
    assert!(client
        .delete(format!("{base}/api/admin/client-keys/{acme_id}"))
        .bearer_auth(&acme_manager)
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    assert!(!accepted(new_secret).await);
    assert!(accepted(red_secret).await);

    // An unknown key is not found.
    assert_eq!(
        client
            .post(format!("{base}/api/admin/client-keys/key_missing/rotate"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    gateway_task.abort();
    database.close().await.unwrap();
}
