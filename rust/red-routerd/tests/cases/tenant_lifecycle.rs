// Legacy `DELETE /api/tenants/:id`: only an empty, non-default tenant is
// deleted, by the global admin, and the deletion is audited.
#[tokio::test]
async fn only_an_empty_non_default_tenant_is_deleted() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("tenant-delete.sqlite")).unwrap();
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
    let (chat_id, _) = issue(serde_json::json!({
        "label":"Acme chat","tenant_id":"acme","scopes":["inference:chat"]
    }))
    .await;
    let (manager_id, manager) = issue(serde_json::json!({
        "label":"Acme manager","tenant_id":"acme","scopes":["manage"]
    }))
    .await;
    let delete = |id: &str, key: &str| {
        client
            .delete(format!("{base}/api/admin/tenants/{id}"))
            .bearer_auth(key)
            .send()
    };
    assert_eq!(
        delete("red", ADMIN_KEY).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        delete("ghost", ADMIN_KEY).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    // A tenant's own management key is not the global admin.
    assert_eq!(
        delete("acme", &manager).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let busy = delete("acme", ADMIN_KEY).await.unwrap();
    assert_eq!(busy.status(), StatusCode::CONFLICT);
    assert!(busy
        .text()
        .await
        .unwrap()
        .contains("Move or delete them first"));

    // Revoked keys are only disabled; they do not keep the tenant alive.
    for id in [&chat_id, &manager_id] {
        assert!(client
            .delete(format!("{base}/api/admin/client-keys/{id}"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
    }
    let deleted = delete("acme", ADMIN_KEY).await.unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);
    let tenants: serde_json::Value = client
        .get(format!("{base}/api/admin/tenants"))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!tenants.to_string().contains("\"acme\""), "{tenants}");
    assert_eq!(
        delete("acme", ADMIN_KEY).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    let audit = client
        .get(format!(
            "{base}/api/compliance/audit-log?action=tenant.delete"
        ))
        .bearer_auth(ADMIN_KEY)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(audit.contains("tenant.delete"), "{audit}");
    gateway_task.abort();
    database.close().await.unwrap();
}
