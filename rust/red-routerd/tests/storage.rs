use red_routerd::storage::{Backend, Database};
use tempfile::TempDir;
use url::Url;

async fn exercise(backend: Backend, url: &str) {
    let db = Database::connect(backend, url).await.unwrap();
    assert_eq!(db.upstream().await.unwrap(), None);
    db.seed("https://first.example/v1/chat/completions")
        .await
        .unwrap();
    db.seed("https://ignored.example/v1/chat/completions")
        .await
        .unwrap();
    assert_eq!(
        db.upstream().await.unwrap().as_deref(),
        Some("https://first.example/v1/chat/completions")
    );
    db.set_upstream("https://second.example/v1/chat/completions")
        .await
        .unwrap();
    db.close().await.unwrap();
    drop(db);
    let reopened = Database::connect(backend, url).await.unwrap();
    assert_eq!(
        reopened.upstream().await.unwrap().as_deref(),
        Some("https://second.example/v1/chat/completions")
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_configuration_survives_restart() {
    let temp = TempDir::new().unwrap();
    let file = Url::from_file_path(temp.path().join("config.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    exercise(Backend::Sqlite, &url).await;
}

#[cfg(feature = "reddb-embedded")]
#[tokio::test]
async fn embedded_reddb_configuration_survives_restart() {
    let temp = TempDir::new().unwrap();
    let url = Url::from_file_path(temp.path().join("config.rdb")).unwrap();
    exercise(Backend::ReddbEmbedded, url.as_str()).await;
}

#[cfg(feature = "reddb-embedded")]
#[tokio::test]
async fn embedded_reddb_refuses_a_second_owner() {
    let temp = TempDir::new().unwrap();
    let url = Url::from_file_path(temp.path().join("config.rdb")).unwrap();
    let first = Database::connect(Backend::ReddbEmbedded, url.as_str())
        .await
        .unwrap();
    assert!(Database::connect(Backend::ReddbEmbedded, url.as_str())
        .await
        .is_err());
    first.close().await.unwrap();
    drop(first);
    let second = Database::connect(Backend::ReddbEmbedded, url.as_str())
        .await
        .unwrap();
    second.close().await.unwrap();
}

async fn remote(backend: Backend, variable: &str) {
    let Ok(url) = std::env::var(variable) else {
        return;
    };
    assert_eq!(
        std::env::var("RED_ROUTER_TEST_DISPOSABLE").as_deref(),
        Ok("1")
    );
    exercise(backend, &url).await;
}

#[tokio::test]
async fn remote_postgres_configuration_survives_reconnect() {
    remote(Backend::Postgres, "RED_ROUTER_TEST_POSTGRES_URL").await;
}

#[tokio::test]
async fn remote_reddb_configuration_survives_reconnect() {
    remote(Backend::ReddbRemote, "RED_ROUTER_TEST_REDDB_URL").await;
}

#[tokio::test]
async fn unavailable_or_mismatched_database_never_falls_back() {
    assert!(Database::connect(
        Backend::Sqlite,
        "postgresql://secret:private@127.0.0.1/test"
    )
    .await
    .is_err());
    let error = match Database::connect(
        Backend::Postgres,
        "postgresql://secret:private@127.0.0.1:1/test",
    )
    .await
    {
        Ok(_) => panic!("expected connection failure"),
        Err(error) => error,
    };
    assert!(!error.contains("private"));
}
