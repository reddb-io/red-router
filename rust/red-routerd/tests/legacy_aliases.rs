use red_routerd::{
    legacy_aliases,
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
    sqlx::query("INSERT INTO key_value VALUES ('modelAliases','fast',?),('modelAliases','other',?),('settings','modelAliases',?)")
        .bind(r#""openai/old-model""#).bind(r#""openai/other-model""#).bind(r#"{"fast":"openai/new-model"}"#)
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
    assert_eq!((report.imported, report.already_present), (2, 0));
    let repeat = legacy_aliases::import(&source, &destination).await.unwrap();
    assert_eq!((repeat.imported, repeat.already_present), (0, 2));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let aliases = db.model_aliases().await.unwrap();
    assert_eq!(aliases.len(), 2);
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
        2,
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
    assert_eq!(db.model_aliases().await.unwrap().len(), 2);
    db.close().await.unwrap();
}
