// Ported from tests/unit/combo-auto-promote.test.ts: with the legacy
// comboAutoPromoteEnabled flag on, the combo target that answered moves to
// the front of the stored combo; without it the order stays.
#[tokio::test]
async fn successful_combo_targets_are_promoted_only_when_enabled() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("auto-promote.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
    let control = ControlPlane::new(database, ADMIN_KEY, STORAGE_KEY, false)
        .await
        .unwrap();
    let (failing_url, _requests, failing_status, _body, failing_task) =
        model_scoped_provider("promote-failing-secret").await;
    failing_status.store(500, Ordering::SeqCst);
    let (working_url, working_task) = provider("promote-working-secret", "promoted-ok").await;
    let (base, gateway_task) = gateway(control).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (id, upstream_url, api_key) in [
        ("promote-failing", failing_url, "promote-failing-secret"),
        ("promote-working", working_url, "promote-working-secret"),
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
            .put(format!("{base}/api/admin/client-keys/promote-client"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "label":"Auto promote client",
                "api_key":RUST_CLIENT_KEY,
                "scopes":["inference:chat"],
                "allowed_endpoints":["chat"],
                "allowed_models":["promote-combo","missing-model","working-model"],
                "allowed_provider_ids":["promote-failing","promote-working"]
            }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let define = || {
        client
            .put(format!("{base}/api/admin/combos/promote-combo"))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!({
                "strategy":"priority",
                "fallback":true,
                "targets":[
                    {"provider_id":"promote-failing","model":"missing-model"},
                    {"provider_id":"promote-working","model":"working-model"}
                ]
            }))
            .send()
    };
    assert_eq!(define().await.unwrap().status(), StatusCode::OK);
    // The listing may briefly fail while the request's own state writes land.
    let first_target = || async {
        for _ in 0..20 {
            let listed: serde_json::Value = client
                .get(format!("{base}/api/admin/combos"))
                .bearer_auth(ADMIN_KEY)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if let Some(combos) = listed["combos"].as_array() {
                return combos
                    .iter()
                    .find(|combo| combo["id"] == "promote-combo")
                    .unwrap()["targets"][0]["provider_id"]
                    .as_str()
                    .unwrap()
                    .to_owned();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the combo listing stayed unavailable");
    };

    // Off by default: the order stays.
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "promote-combo")
            .await
            .text()
            .await
            .unwrap(),
        "promoted-ok"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(first_target().await, "promote-failing");

    assert_eq!(
        client
            .put(format!(
                "{base}/api/admin/global-settings/combo_auto_promote"
            ))
            .bearer_auth(ADMIN_KEY)
            .json(&serde_json::json!(true))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    // A fresh combo definition clears the failing target's cooldown state.
    assert_eq!(define().await.unwrap().status(), StatusCode::OK);
    assert_eq!(
        client
            .delete(format!("{base}/api/admin/provider-health/promote-failing"))
            .bearer_auth(ADMIN_KEY)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        chat_model(&client, &base, RUST_CLIENT_KEY, "promote-combo")
            .await
            .text()
            .await
            .unwrap(),
        "promoted-ok"
    );
    let mut promoted = String::new();
    for _ in 0..40 {
        promoted = first_target().await;
        if promoted == "promote-working" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(promoted, "promote-working");

    gateway_task.abort();
    failing_task.abort();
    working_task.abort();
}
