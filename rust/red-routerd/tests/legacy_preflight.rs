use red_routerd::legacy_preflight;
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::TempDir;
use url::Url;

#[tokio::test]
async fn inspection_counts_known_tables_without_exposing_or_modifying_records() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("legacy.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql("CREATE TABLE provider_connections (id TEXT, api_key TEXT); INSERT INTO provider_connections VALUES ('private-id','secret-provider'); CREATE TABLE api_keys (id TEXT, key TEXT); INSERT INTO api_keys VALUES ('private-key','secret-client'); CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT); INSERT INTO key_value VALUES ('pricing','cohere','secret-pricing'),('settings','unrelated','secret-setting'),('customModels','private-provider','secret-model'),('modelAliases','private-alias','secret-target'),('syncedAvailableModels','private-provider:private-id','secret-inventory');")
        .execute(&mut db).await.unwrap();
    db.close().await.unwrap();
    let before = tokio::fs::read(&path).await.unwrap();
    let report = legacy_preflight::inspect(&path).await.unwrap();
    let encoded = serde_json::to_string(&report).unwrap();
    assert!(!report.migration_ready);
    assert_eq!(report.pricing_rows, Some(1));
    assert_eq!(report.version, 2);
    assert_eq!(
        report
            .model_namespaces
            .iter()
            .find(|item| item.namespace == "syncedAvailableModels")
            .unwrap()
            .rows,
        Some(1)
    );
    assert_eq!(
        report
            .model_namespaces
            .iter()
            .find(|item| item.namespace == "customModels")
            .unwrap()
            .rows,
        Some(1)
    );
    assert_eq!(
        report
            .model_namespaces
            .iter()
            .find(|item| item.namespace == "modelAliases")
            .unwrap()
            .rows,
        Some(1)
    );
    assert_eq!(
        report
            .model_namespaces
            .iter()
            .find(|item| item.namespace == "providerAliases")
            .unwrap()
            .rows,
        Some(0)
    );
    assert_eq!(
        report
            .tables
            .iter()
            .find(|item| item.table == "provider_connections")
            .unwrap()
            .rows,
        Some(1)
    );
    assert_eq!(
        report
            .tables
            .iter()
            .find(|item| item.table == "api_keys")
            .unwrap()
            .rows,
        Some(1)
    );
    assert_eq!(
        report
            .tables
            .iter()
            .find(|item| item.table == "combos")
            .unwrap()
            .rows,
        None
    );
    assert!(!encoded.contains("secret-"));
    assert!(!encoded.contains("private-"));
    assert_eq!(before, tokio::fs::read(&path).await.unwrap());
}

#[tokio::test]
async fn inspection_distinguishes_missing_model_storage_from_empty_namespaces() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("legacy.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let db = SqliteConnection::connect_with(&options).await.unwrap();
    db.close().await.unwrap();
    let report = legacy_preflight::inspect(&path).await.unwrap();
    assert!(report
        .model_namespaces
        .iter()
        .all(|item| item.rows.is_none()));
}

#[tokio::test]
async fn inspection_refuses_missing_database_without_creating_it() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("missing.sqlite");
    assert!(legacy_preflight::inspect(&path).await.is_err());
    assert!(!path.exists());
}

#[tokio::test]
async fn synced_model_staging_preserves_full_records_and_rolls_back_conflicts() {
    let dir = TempDir::new().unwrap();
    let source = dir.path().join("source.sqlite");
    let destination = dir.path().join("destination.sqlite");
    let mut legacy = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TABLE key_value(namespace TEXT,key TEXT,value TEXT); INSERT INTO key_value VALUES('syncedAvailableModels','provider:z','[{\"id\":\"old\",\"future\":true}]');").execute(&mut legacy).await.unwrap();
    legacy.close().await.unwrap();
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&destination)
            .create_if_missing(true),
    )
    .await
    .unwrap()
    .close()
    .await
    .unwrap();
    let original = tokio::fs::read(&source).await.unwrap();
    let first = legacy_preflight::stage_synced_models(&source, &destination)
        .await
        .unwrap();
    assert_eq!((first.staged, first.already_present), (1, 0));
    let repeat = legacy_preflight::stage_synced_models(&source, &destination)
        .await
        .unwrap();
    assert_eq!((repeat.staged, repeat.already_present), (0, 1));
    assert_eq!(tokio::fs::read(&source).await.unwrap(), original);
    let mut legacy = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::raw_sql("INSERT INTO key_value VALUES('syncedAvailableModels','provider:a','[]'); UPDATE key_value SET value='[{\"id\":\"changed\"}]' WHERE key='provider:z';").execute(&mut legacy).await.unwrap();
    legacy.close().await.unwrap();
    assert!(legacy_preflight::stage_synced_models(&source, &destination)
        .await
        .unwrap_err()
        .contains("conflicting"));
    let mut result =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&destination))
            .await
            .unwrap();
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT legacy_key,value FROM redrouter_legacy_synced_model_records ORDER BY legacy_key",
    )
    .fetch_all(&mut result)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![(
            "provider:z".to_owned(),
            "[{\"id\":\"old\",\"future\":true}]".to_owned()
        )]
    );
    result.close().await.unwrap();
}

#[tokio::test]
async fn pricing_import_is_atomic_idempotent_and_does_not_touch_source() {
    let directory = TempDir::new().unwrap();
    let source = directory.path().join("legacy.sqlite");
    let destination = directory.path().join("rust.sqlite");
    let options = |path: &std::path::Path| {
        SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
    };
    let mut input = SqliteConnection::connect_with(&options(&source))
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT, PRIMARY KEY(namespace,key)); INSERT INTO key_value VALUES ('pricing','a','{\"price\":1}'),('pricing','b','{\"price\":2}'),('settings','secret','do-not-copy');")
        .execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    let source_bytes = tokio::fs::read(&source).await.unwrap();
    let mut output = SqliteConnection::connect_with(&options(&destination))
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT, PRIMARY KEY(namespace,key)); INSERT INTO key_value VALUES ('pricing','b','different');")
        .execute(&mut output).await.unwrap();
    output.close().await.unwrap();

    assert!(legacy_preflight::import_pricing(&source, &destination)
        .await
        .is_err());
    let mut output = SqliteConnection::connect_with(&options(&destination))
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM key_value WHERE key = 'a'")
        .fetch_one(&mut output)
        .await
        .unwrap();
    assert_eq!(count, 0, "conflict must roll back earlier inserts");
    sqlx::query("UPDATE key_value SET value = ? WHERE namespace='pricing' AND key='b'")
        .bind(r#"{"price":2}"#)
        .execute(&mut output)
        .await
        .unwrap();
    output.close().await.unwrap();

    let imported = legacy_preflight::import_pricing(&source, &destination)
        .await
        .unwrap();
    assert_eq!((imported.inserted, imported.already_present), (1, 1));
    let repeated = legacy_preflight::import_pricing(&source, &destination)
        .await
        .unwrap();
    assert_eq!((repeated.inserted, repeated.already_present), (0, 2));
    assert_eq!(source_bytes, tokio::fs::read(&source).await.unwrap());
    let mut output = SqliteConnection::connect_with(&options(&destination))
        .await
        .unwrap();
    let settings: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM key_value WHERE namespace='settings'")
            .fetch_one(&mut output)
            .await
            .unwrap();
    assert_eq!(settings, 0);
    assert!(legacy_preflight::import_pricing(&source, &source)
        .await
        .is_err());
}

#[tokio::test]
async fn custom_model_import_is_transactional_and_preserves_metadata() {
    use red_routerd::{
        legacy_models,
        storage::{Backend, Database},
    };
    let dir = TempDir::new().unwrap();
    let source = dir.path().join("legacy.sqlite");
    let destination = dir.path().join("native.sqlite");
    let mut input = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::query(
        "CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT, PRIMARY KEY(namespace,key))",
    )
    .execute(&mut input)
    .await
    .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('customModels','openai',?)")
        .bind(r#"[{"id":"custom-1","name":"Custom Model","source":"manual","apiFormat":"chat-completions","supportedEndpoints":["chat"],"inputTokenLimit":32000,"outputTokenLimit":4000,"supportsThinking":false}]"#)
        .execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    let before = tokio::fs::read(&source).await.unwrap();
    let file = Url::from_file_path(&destination).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    let report = legacy_models::import(&source, &destination).await.unwrap();
    assert_eq!((report.imported, report.already_present), (1, 0));
    let report = legacy_models::import(&source, &destination).await.unwrap();
    assert_eq!((report.imported, report.already_present), (0, 1));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let models = db.provider_models().await.unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].provider, "openai");
    assert_eq!(models[0].metadata.name.as_deref(), Some("Custom Model"));
    assert_eq!(models[0].metadata.reasoning, Some(false));
    assert_eq!(
        models[0].metadata.limit.as_ref().unwrap().input,
        Some(32000)
    );
    assert_eq!(
        models[0].metadata.limit.as_ref().unwrap().output,
        Some(4000)
    );
    db.close().await.unwrap();
    assert_eq!(before, tokio::fs::read(&source).await.unwrap());

    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('customModels','z-provider',?)")
        .bind(r#"[{"id":"unsafe","targetFormat":"claude"}]"#)
        .execute(&mut input)
        .await
        .unwrap();
    sqlx::query("UPDATE key_value SET value=? WHERE namespace='customModels' AND key='openai'")
        .bind(r#"[{"id":"new-model","source":"manual"}]"#)
        .execute(&mut input)
        .await
        .unwrap();
    input.close().await.unwrap();
    assert!(legacy_models::import(&source, &destination).await.is_err());
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert_eq!(
        db.provider_models().await.unwrap().len(),
        1,
        "a later unsupported model must roll back earlier inserts"
    );
    db.close().await.unwrap();
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::query("DELETE FROM key_value WHERE namespace='customModels' AND key='z-provider'")
        .execute(&mut input)
        .await
        .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('modelCompatOverrides','openai',?)")
        .bind(r#"[{"id":"new-model","isHidden":true}]"#)
        .execute(&mut input)
        .await
        .unwrap();
    input.close().await.unwrap();
    assert_eq!(
        legacy_models::import(&source, &destination)
            .await
            .unwrap_err(),
        "legacy model compatibility settings require migration"
    );
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert_eq!(
        db.provider_models().await.unwrap().len(),
        1,
        "a model with unmigrated visibility must not be imported"
    );
    db.close().await.unwrap();
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::query(
        "UPDATE key_value SET value=? WHERE namespace='modelCompatOverrides' AND key='openai'",
    )
    .bind(r#"[{"id":"different-model","isHidden":true},{"id":"new-model","isDeleted":true}]"#)
    .execute(&mut input)
    .await
    .unwrap();
    input.close().await.unwrap();
    assert_eq!(
        legacy_models::import(&source, &destination)
            .await
            .unwrap()
            .imported,
        1,
        "unrelated overrides and legacy tombstones must not block this import"
    );
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('customModels','opencode-zen',?)")
        .bind(r#"[{"id":"sibling-model","source":"manual"}]"#)
        .execute(&mut input)
        .await
        .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('modelCompatOverrides','opencode',?)")
        .bind(r#"[{"id":"sibling-model","targetFormat":"claude"}]"#)
        .execute(&mut input)
        .await
        .unwrap();
    input.close().await.unwrap();
    assert_eq!(
        legacy_models::import(&source, &destination)
            .await
            .unwrap_err(),
        "legacy model compatibility settings require migration",
        "legacy no-auth sibling overrides must not be dropped"
    );
}

#[tokio::test]
async fn custom_node_model_import_preserves_tenant_and_requires_matching_definition() {
    use red_routerd::{
        legacy_models, legacy_provider_nodes,
        storage::{Backend, Database},
    };
    let dir = TempDir::new().unwrap();
    let source = dir.path().join("legacy-node.sqlite");
    let destination = dir.path().join("native-node.sqlite");
    let id = "openai-compatible-chat-12345678-1234-1234-1234-123456789abc";
    let mut input = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT, PRIMARY KEY(namespace,key)); CREATE TABLE provider_nodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, prefix TEXT, base_url TEXT, tenant_id TEXT);").execute(&mut input).await.unwrap();
    sqlx::query("INSERT INTO provider_nodes VALUES (?,'openai-compatible','Gateway','acme-gateway','https://gateway.example/v1','acme')").bind(id).execute(&mut input).await.unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('customModels',?,?)").bind(id).bind(r#"[{"id":"internal-model","name":"Internal","source":"manual","apiFormat":"chat-completions","supportedEndpoints":["chat"],"inputTokenLimit":8192}]"#).execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    let before = tokio::fs::read(&source).await.unwrap();
    let file = Url::from_file_path(&destination).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    let mut target =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&destination))
            .await
            .unwrap();
    sqlx::query("INSERT INTO redrouter_control_tenants VALUES ('acme','acme','Acme',1,1)")
        .execute(&mut target)
        .await
        .unwrap();
    target.close().await.unwrap();
    assert!(
        legacy_models::import(&source, &destination).await.is_err(),
        "missing definition must not be guessed"
    );
    legacy_provider_nodes::import(&source, &destination, "test-storage-key-at-least-16-bytes")
        .await
        .unwrap();
    let report = legacy_models::import(&source, &destination).await.unwrap();
    assert_eq!((report.imported, report.already_present), (1, 0));
    let repeat = legacy_models::import(&source, &destination).await.unwrap();
    assert_eq!((repeat.imported, repeat.already_present), (0, 1));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let models = db.provider_models().await.unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(
        (&models[0].tenant_id, &models[0].provider),
        (&"acme".to_owned(), &"acme-gateway".to_owned())
    );
    assert_eq!(models[0].metadata.limit.as_ref().unwrap().input, Some(8192));
    db.close().await.unwrap();
    assert_eq!(before, tokio::fs::read(&source).await.unwrap());
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::query("UPDATE provider_nodes SET prefix='changed' WHERE id=?")
        .bind(id)
        .execute(&mut input)
        .await
        .unwrap();
    input.close().await.unwrap();
    assert!(
        legacy_models::import(&source, &destination).await.is_err(),
        "a mismatched definition must fail closed"
    );
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::query("UPDATE provider_nodes SET prefix='acme-gateway',base_url='https://other.example/v1' WHERE id=?").bind(id).execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    assert!(
        legacy_models::import(&source, &destination).await.is_err(),
        "a changed endpoint must not be mistaken for the imported definition"
    );
}
