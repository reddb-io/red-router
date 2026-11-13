use red_routerd::storage::{
    Backend, Database, StoredProvider, StoredProviderDiscovery, StoredProviderHeaders,
    StoredProviderNode,
};
use sqlx::{sqlite::SqliteConnectOptions, Connection};
use tempfile::TempDir;
use url::Url;

#[tokio::test]
async fn upgrade_marks_prior_migrated_inventory_unknown_until_a_live_probe() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("origin-upgrade.sqlite");
    let file = Url::from_file_path(&path).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    db.upsert_provider(&StoredProvider {
        id: "account".into(),
        tenant_id: "red".into(),
        provider: "vllm".into(),
        upstream_url: "https://example.test/v1/chat/completions".into(),
        credential_ciphertext: "fixture".into(),
        enabled: true,
        updated_at: 10,
        node_id: None,
        protocol: "openai".into(),
        priority: 0,
        default_model: None,
    })
    .await
    .unwrap();
    let ticket = db
        .begin_synced_model_probe("account", "red")
        .await
        .unwrap()
        .unwrap();
    assert!(db
        .publish_synced_models(&ticket, r#"[{"id":"old"}]"#, 1_000)
        .await
        .unwrap());
    db.close().await.unwrap();
    let mut legacy =
        sqlx::SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
    for query in [
        "DROP TABLE redrouter_synced_model_legacy_origin",
        "CREATE TABLE redrouter_legacy_provider_records(provider_id TEXT PRIMARY KEY, encrypted_record TEXT NOT NULL)",
        "CREATE TABLE redrouter_legacy_provider_migration(provider_id TEXT PRIMARY KEY, source_enabled BIGINT NOT NULL)",
        "INSERT INTO redrouter_legacy_provider_records VALUES ('account','fixture')",
        "INSERT INTO redrouter_legacy_provider_migration VALUES ('account',1)",
    ] { sqlx::query(query).execute(&mut legacy).await.unwrap(); }
    legacy.close().await.unwrap();
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let old = db
        .synced_models("account", "red", 1_100, 1_000)
        .await
        .unwrap()
        .unwrap();
    assert!(!old.source_verified);
    let ticket = db
        .begin_synced_model_probe("account", "red")
        .await
        .unwrap()
        .unwrap();
    assert!(
        !db.synced_models("account", "red", 1_100, 1_000)
            .await
            .unwrap()
            .unwrap()
            .source_verified
    );
    assert!(db
        .publish_synced_models(&ticket, r#"[{"id":"new"}]"#, 1_100)
        .await
        .unwrap());
    assert!(
        db.synced_models("account", "red", 1_100, 1_000)
            .await
            .unwrap()
            .unwrap()
            .source_verified
    );
    db.close().await.unwrap();
    let restarted = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert!(
        restarted
            .synced_models("account", "red", 1_100, 1_000)
            .await
            .unwrap()
            .unwrap()
            .source_verified
    );
    restarted.close().await.unwrap();
}

#[tokio::test]
async fn synced_inventory_is_tenant_scoped_generation_bound_and_survives_restart() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("synced-inventory.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let first = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let second = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let provider = StoredProvider {
        id: "account".into(),
        tenant_id: "red".into(),
        provider: "private-api".into(),
        upstream_url: "https://example.test/v1/chat/completions".into(),
        credential_ciphertext: "encrypted-fixture".into(),
        enabled: true,
        updated_at: 10,
        node_id: None,
        protocol: "openai".into(),
        priority: 0,
        default_model: None,
    };
    first.upsert_provider(&provider).await.unwrap();
    assert!(first
        .begin_synced_model_probe("account", "other")
        .await
        .unwrap()
        .is_none());
    let old = first
        .begin_synced_model_probe("account", "red")
        .await
        .unwrap()
        .unwrap();
    let newer = second
        .begin_synced_model_probe("account", "red")
        .await
        .unwrap()
        .unwrap();
    assert!(newer.generation > old.generation);
    assert!(!first.synced_model_probe_current(&old).await.unwrap());
    assert!(second.synced_model_probe_current(&newer).await.unwrap());
    assert!(!first
        .publish_synced_models(&old, r#"[{"id":"old"}]"#, 1_000)
        .await
        .unwrap());
    assert!(second
        .publish_synced_models(&newer, r#"[{"id":"new"}]"#, 1_000)
        .await
        .unwrap());
    let next = first
        .begin_synced_model_probe("account", "red")
        .await
        .unwrap()
        .unwrap();
    let snapshot = second
        .synced_models("account", "red", 1_100, 200)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.models_json, r#"[{"id":"new"}]"#);
    assert_eq!(
        snapshot.generation, newer.generation,
        "an unfinished probe preserves the last success"
    );
    assert!(second
        .synced_models("account", "other", 1_100, 200)
        .await
        .unwrap()
        .is_none());
    assert!(second
        .synced_models("account", "red", 1_201, 200)
        .await
        .unwrap()
        .is_none());
    assert!(first
        .publish_synced_models(&next, "[]", 1_100)
        .await
        .unwrap());
    first.delete_synced_models("account").await.unwrap();
    let before_purge = first
        .begin_synced_model_probe("account", "red")
        .await
        .unwrap()
        .unwrap();
    first.delete_synced_models("account").await.unwrap();
    let after_purge = second
        .begin_synced_model_probe("account", "red")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(before_purge.generation, after_purge.generation);
    assert!(!first
        .publish_synced_models(&before_purge, r#"[{"id":"old"}]"#, 1_100)
        .await
        .unwrap());
    assert!(second
        .publish_synced_models(&after_purge, "[]", 1_100)
        .await
        .unwrap());
    first.close().await.unwrap();
    second.close().await.unwrap();
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert_eq!(
        db.synced_models("account", "red", 1_100, 200)
            .await
            .unwrap()
            .unwrap()
            .models_json,
        "[]"
    );

    let stale = db
        .begin_synced_model_probe("account", "red")
        .await
        .unwrap()
        .unwrap();
    db.upsert_provider_discovery(&StoredProviderDiscovery {
        provider_id: "account".into(),
        models_path: "/v1/models".into(),
        revision: 20,
    })
    .await
    .unwrap();
    assert!(db
        .synced_models("account", "red", 1_100, 200)
        .await
        .unwrap()
        .is_none());
    assert!(!db
        .publish_synced_models(&stale, r#"[{"id":"stale"}]"#, 1_100)
        .await
        .unwrap());
    let fresh = db
        .begin_synced_model_probe("account", "red")
        .await
        .unwrap()
        .unwrap();
    assert!(db
        .publish_synced_models(&fresh, r#"[{"id":"new"}]"#, 1_100)
        .await
        .unwrap());
    db.upsert_provider_header(&StoredProviderHeaders {
        provider_id: "account".into(),
        upstream_identity: "identity".into(),
        headers_ciphertext: "encrypted".into(),
        revision: 30,
    })
    .await
    .unwrap();
    assert!(db
        .synced_models("account", "red", 1_100, 200)
        .await
        .unwrap()
        .is_none());
    let stale = db
        .begin_synced_model_probe("account", "red")
        .await
        .unwrap()
        .unwrap();
    let mut changed = provider.clone();
    changed.updated_at = 40;
    changed.credential_ciphertext = "different-ciphertext".into();
    db.upsert_provider(&changed).await.unwrap();
    assert!(!db.publish_synced_models(&stale, "[]", 1_100).await.unwrap());
    assert!(db
        .synced_models("account", "red", 1_100, 200)
        .await
        .unwrap()
        .is_none());
    let disabled = db
        .begin_synced_model_probe("account", "red")
        .await
        .unwrap()
        .unwrap();
    db.disable_provider("account", 50).await.unwrap();
    assert!(!db
        .publish_synced_models(&disabled, "[]", 1_100)
        .await
        .unwrap());
    assert!(db
        .begin_synced_model_probe("account", "red")
        .await
        .unwrap()
        .is_none());
    db.delete_synced_models("account").await.unwrap();
    db.close().await.unwrap();
}

#[tokio::test]
async fn synced_inventory_invalidates_when_shared_provider_definition_changes() {
    let directory = TempDir::new().unwrap();
    let file = Url::from_file_path(directory.path().join("synced-node.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let node = StoredProviderNode {
        id: "node".into(),
        tenant_id: "red".into(),
        name: "Node".into(),
        prefix: "private-api".into(),
        protocol: "openai".into(),
        base_url: "https://example.test/v1".into(),
        chat_path: "/chat/completions".into(),
        upstream_url: "https://example.test/v1/chat/completions".into(),
        models_path: None,
        revision: 1,
        header_config: None,
    };
    db.upsert_provider_node(&node, None).await.unwrap();
    let provider = StoredProvider {
        id: "account".into(),
        tenant_id: "red".into(),
        provider: "private-api".into(),
        upstream_url: node.upstream_url.clone(),
        credential_ciphertext: "encrypted".into(),
        enabled: true,
        updated_at: 10,
        node_id: Some("node".into()),
        protocol: "openai".into(),
        priority: 0,
        default_model: None,
    };
    db.upsert_provider(&provider).await.unwrap();
    let ticket = db
        .begin_synced_model_probe("account", "red")
        .await
        .unwrap()
        .unwrap();
    assert!(db
        .publish_synced_models(&ticket, "[]", 1_000)
        .await
        .unwrap());
    let mut updated = node;
    updated.revision = 2;
    updated.name = "Changed".into();
    db.upsert_provider_node(&updated, Some(1)).await.unwrap();
    assert!(db
        .synced_models("account", "red", 1_000, 60_000)
        .await
        .unwrap()
        .is_none());
    assert!(!db
        .publish_synced_models(&ticket, "[]", 1_000)
        .await
        .unwrap());
    db.close().await.unwrap();
}
