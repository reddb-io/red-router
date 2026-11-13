use red_routerd::{
    legacy_aliases, legacy_provider_nodes,
    storage::{Backend, Database},
};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::tempdir;
use url::Url;

#[tokio::test]
async fn legacy_aliases_preserve_settings_precedence_and_refuse_lossy_import() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("legacy.sqlite");
    let destination = dir.path().join("native.sqlite");
    let mut source_db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TABLE key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key))").execute(&mut source_db).await.unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('modelAliases','fast',?),('modelAliases','other',?),('modelAliases','openrouter-alias',?),('modelAliases','deepseek-alias',?),('settings','modelAliases',?)")
        .bind(r#""openai/old-model""#).bind(r#""openai/other-model""#).bind(r#""openrouter/provider/model""#).bind(r#""ds/deepseek-chat""#).bind(r#"{"fast":"openai/new-model"}"#)
        .execute(&mut source_db).await.unwrap();
    source_db.close().await.unwrap();
    let source_before = tokio::fs::read(&source).await.unwrap();
    let file = Url::from_file_path(&destination).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    let report = legacy_aliases::import(&source, &destination).await.unwrap();
    assert_eq!((report.imported, report.already_present), (4, 0));
    let repeat = legacy_aliases::import(&source, &destination).await.unwrap();
    assert_eq!((repeat.imported, repeat.already_present), (0, 4));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let aliases = db.model_aliases().await.unwrap();
    assert_eq!(aliases.len(), 4);
    let deepseek = aliases
        .iter()
        .find(|a| a.alias == "deepseek-alias")
        .unwrap();
    assert_eq!(deepseek.provider, "deepseek");
    assert_eq!(deepseek.model, "deepseek-chat");
    let openrouter = aliases
        .iter()
        .find(|a| a.alias == "openrouter-alias")
        .unwrap();
    assert_eq!(openrouter.provider, "openrouter");
    assert_eq!(openrouter.model, "provider/model");
    assert_eq!(
        aliases.iter().find(|a| a.alias == "fast").unwrap().model,
        "new-model"
    );
    assert!(db.alias_routing_configured().await.unwrap());
    db.close().await.unwrap();
    assert_eq!(source_before, tokio::fs::read(&source).await.unwrap());

    let mut source_db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
            .await
            .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('modelAliases','a-new',?),('modelAliases','z-unsupported',?)")
        .bind(r#""openai/new""#).bind(r#""anthropic/claude""#).execute(&mut source_db).await.unwrap();
    source_db.close().await.unwrap();
    assert_eq!(
        legacy_aliases::import(&source, &destination)
            .await
            .unwrap_err(),
        "legacy alias destination requires migration"
    );
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert_eq!(
        db.model_aliases().await.unwrap().len(),
        4,
        "a later unsupported alias must roll back previous inserts"
    );
    db.close().await.unwrap();

    let mut source_db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
            .await
            .unwrap();
    sqlx::query("DELETE FROM key_value WHERE namespace='modelAliases' AND key='z-unsupported'")
        .execute(&mut source_db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('settings','wildcardAliases',?)")
        .bind(r#"[{"pattern":"fast-*","target":"openai/new"}]"#)
        .execute(&mut source_db)
        .await
        .unwrap();
    source_db.close().await.unwrap();
    assert_eq!(
        legacy_aliases::import(&source, &destination)
            .await
            .unwrap_err(),
        "legacy wildcard aliases require migration"
    );

    let mut source_db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
            .await
            .unwrap();
    sqlx::query("DELETE FROM key_value WHERE namespace='settings' AND key='wildcardAliases'")
        .execute(&mut source_db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('managedModelAliasNames','names',?)")
        .bind(r#"["fast"]"#)
        .execute(&mut source_db)
        .await
        .unwrap();
    source_db.close().await.unwrap();
    assert_eq!(
        legacy_aliases::import(&source, &destination)
            .await
            .unwrap_err(),
        "managed aliases require migration"
    );
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert_eq!(db.model_aliases().await.unwrap().len(), 4);
    db.close().await.unwrap();

    let mut source_db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
            .await
            .unwrap();
    sqlx::query("DELETE FROM key_value WHERE namespace='managedModelAliasNames'")
        .execute(&mut source_db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('providerAliases','openai',?)")
        .bind(r#"{"new-model":"different-model"}"#)
        .execute(&mut source_db)
        .await
        .unwrap();
    source_db.close().await.unwrap();
    assert_eq!(
        legacy_aliases::import(&source, &destination)
            .await
            .unwrap_err(),
        "provider-scoped aliases require migration"
    );
    let mut source_db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
            .await
            .unwrap();
    sqlx::query("DELETE FROM key_value WHERE namespace='providerAliases'")
        .execute(&mut source_db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('settings','stripModelPrefix','true')")
        .execute(&mut source_db)
        .await
        .unwrap();
    source_db.close().await.unwrap();
    assert_eq!(
        legacy_aliases::import(&source, &destination)
            .await
            .unwrap_err(),
        "legacy prefix stripping requires migration"
    );
    let mut source_db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
            .await
            .unwrap();
    sqlx::query("DELETE FROM key_value WHERE namespace='settings' AND key='stripModelPrefix'")
        .execute(&mut source_db)
        .await
        .unwrap();
    source_db.close().await.unwrap();
    let mut dest_db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&destination))
            .await
            .unwrap();
    sqlx::query("INSERT INTO redrouter_control_tenants (id,slug,name,enabled,revision) VALUES ('other','other','Other',1,1)").execute(&mut dest_db).await.unwrap();
    dest_db.close().await.unwrap();
    assert_eq!(
        legacy_aliases::import(&source, &destination)
            .await
            .unwrap_err(),
        "legacy global aliases require tenant mapping"
    );
}

#[tokio::test]
async fn custom_provider_aliases_require_matching_imported_definition_and_rollback() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("legacy-custom.sqlite");
    let destination = dir.path().join("native-custom.sqlite");
    let id = "openai-compatible-chat-12345678-1234-1234-1234-123456789abc";
    let mut input = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TABLE key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key)); CREATE TABLE provider_nodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, prefix TEXT, base_url TEXT, chat_path TEXT, api_type TEXT);").execute(&mut input).await.unwrap();
    sqlx::query("INSERT INTO provider_nodes VALUES (?,'openai-compatible','Private','private-api','https://private.example/v1','/gateway/chat','chat')").bind(id).execute(&mut input).await.unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('modelAliases','a-builtin',?),('modelAliases','z-prefix',?),('modelAliases','z-node-id',?)")
        .bind(r#""openai/gpt-test""#).bind(r#""private-api/model-x""#).bind(format!("\"{id}/model-y\""))
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
    assert_eq!(
        legacy_aliases::import(&source, &destination)
            .await
            .unwrap_err(),
        "import legacy provider definition before its aliases"
    );
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert!(db.model_aliases().await.unwrap().is_empty());
    db.close().await.unwrap();
    legacy_provider_nodes::import(&source, &destination, "test-storage-key-at-least-16-bytes")
        .await
        .unwrap();
    let report = legacy_aliases::import(&source, &destination).await.unwrap();
    assert_eq!((report.imported, report.already_present), (3, 0));
    let report = legacy_aliases::import(&source, &destination).await.unwrap();
    assert_eq!((report.imported, report.already_present), (0, 3));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let aliases = db.model_aliases().await.unwrap();
    for (alias, model) in [("z-prefix", "model-x"), ("z-node-id", "model-y")] {
        let entry = aliases.iter().find(|entry| entry.alias == alias).unwrap();
        assert_eq!(
            (&*entry.provider, &*entry.model, &*entry.tenant_id),
            ("private-api", model, "red")
        );
    }
    db.close().await.unwrap();
    assert_eq!(before, tokio::fs::read(&source).await.unwrap());
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::query("UPDATE provider_nodes SET base_url='https://other.example/v1' WHERE id=?")
        .bind(id)
        .execute(&mut input)
        .await
        .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('modelAliases','a-new',?)")
        .bind(r#""openai/new""#)
        .execute(&mut input)
        .await
        .unwrap();
    input.close().await.unwrap();
    assert_eq!(
        legacy_aliases::import(&source, &destination)
            .await
            .unwrap_err(),
        "legacy provider definition does not match destination"
    );
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert_eq!(
        db.model_aliases().await.unwrap().len(),
        3,
        "a mismatch must roll back the complete import"
    );
    db.close().await.unwrap();
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::query("UPDATE provider_nodes SET base_url='https://private.example/v1',api_type='responses' WHERE id=?")
        .bind(id).execute(&mut input).await.unwrap();
    input.close().await.unwrap();
    assert_eq!(
        legacy_aliases::import(&source, &destination)
            .await
            .unwrap_err(),
        "legacy alias destination requires migration"
    );
}
