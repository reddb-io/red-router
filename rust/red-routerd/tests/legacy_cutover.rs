use red_routerd::{
    legacy_cutover,
    storage::{Backend, Database},
};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::{tempdir, TempDir};
use url::Url;

const STORAGE_KEY: &str = "0123456789abcdef0123456789abcdef";

async fn model_fixture(model: &str) -> (TempDir, std::path::PathBuf, std::path::PathBuf, String) {
    let directory = tempdir().unwrap();
    let source = directory.path().join("legacy.sqlite");
    let destination = directory.path().join("rust.sqlite");
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql(r#"
        CREATE TABLE api_keys (
          id TEXT PRIMARY KEY, name TEXT, key TEXT, machine_id TEXT, created_at TEXT,
          allowed_models TEXT, model_access_mode TEXT, blocked_models TEXT,
          allowed_combos TEXT, no_log INTEGER, allowed_connections TEXT, auto_resolve INTEGER,
          is_active INTEGER, access_schedule TEXT, max_requests_per_day INTEGER,
          max_requests_per_minute INTEGER, throttle_delay_ms INTEGER, max_sessions INTEGER,
          revoked_at TEXT, expires_at TEXT, last_used_at TEXT, key_prefix TEXT, ip_allowlist TEXT, scopes TEXT,
          rate_limits TEXT, is_banned INTEGER, key_hash TEXT, proxy_id TEXT, allowed_endpoints TEXT,
          allowed_quotas TEXT, stream_default_mode TEXT, cache_default_mode TEXT,
          disable_non_public_models INTEGER, allow_usage_command INTEGER,
          usage_limit_enabled INTEGER, daily_usage_limit_usd REAL, weekly_usage_limit_usd REAL,
          chaos_mode_enabled INTEGER, compression_enabled INTEGER,
          allow_auto_combos INTEGER, catalog_scope TEXT, tenant_id TEXT
        );
        CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT, PRIMARY KEY(namespace,key));
        INSERT INTO key_value VALUES ('pricing','snapshot','new-price');
        CREATE TABLE api_key_token_limits (id TEXT, api_key_id TEXT, scope_type TEXT, scope_value TEXT, token_limit INTEGER, reset_interval TEXT, reset_time TEXT, enabled INTEGER, created_at TEXT, updated_at TEXT);
        CREATE TABLE domain_budgets (id TEXT);
        CREATE TABLE budget_assignments (id TEXT);
        CREATE TABLE key_group_members (id TEXT);
        CREATE TABLE api_key_context_sources (id TEXT);
        CREATE TABLE model_combo_mappings (id TEXT);
        CREATE TABLE provider_nodes (id TEXT PRIMARY KEY,type TEXT,name TEXT,prefix TEXT,base_url TEXT);
        INSERT INTO provider_nodes VALUES ('openai-compatible-chat-12345678-1234-1234-1234-123456789abc','openai-compatible','Gateway','cutover-gateway','https://gateway.example/v1');
        CREATE TABLE provider_connections (id TEXT PRIMARY KEY);
        CREATE TABLE usage_history (id INTEGER PRIMARY KEY);
        CREATE TABLE request_cost_ledger (id INTEGER PRIMARY KEY);
    "#).execute(&mut db).await.unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('customModels','openai-compatible-chat-12345678-1234-1234-1234-123456789abc',?)").bind(model).execute(&mut db).await.unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('modelAliases','router-model',?)")
        .bind(r#""openrouter/vendor/model""#)
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
    let file = Url::from_file_path(&destination).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    (directory, source, destination, url)
}

#[tokio::test]
async fn cutover_imports_models_after_their_provider_definitions() {
    let (dir, source, destination, url) =
        model_fixture(r#"[{"id":"custom-model","source":"manual","inputTokenLimit":16000}]"#).await;
    let mut source_db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
            .await
            .unwrap();
    let original_inventory =
        r#"[{"id":"private-model","supportsVision":true,"futureMetadata":{"keep":"exactly"}}]"#;
    sqlx::query("INSERT INTO key_value VALUES ('syncedAvailableModels',?,?)")
        .bind("openrouter:account-123")
        .bind(original_inventory)
        .execute(&mut source_db)
        .await
        .unwrap();
    source_db.close().await.unwrap();
    let before = tokio::fs::read(&source).await.unwrap();
    let backup = dir.path().join("rollback.sqlite");
    let report = legacy_cutover::migrate(&source, &destination, &backup, STORAGE_KEY)
        .await
        .unwrap();
    assert_eq!(report.version, 5);
    assert!(!report.settings.runtime_settings_imported);
    assert_eq!(report.provider_nodes.imported, 1);
    assert_eq!(report.custom_models.imported, 1);
    assert_eq!(report.model_aliases.imported, 1);
    assert_eq!(report.synced_models.staged, 1);
    assert_eq!(report.synced_models.already_present, 0);
    assert_eq!(report.synced_models.visibility_staged, 1);
    assert!(report.activation_required);
    assert!(report.follow_up.iter().any(|item| item.contains("aliases")));
    assert!(report
        .follow_up
        .iter()
        .any(|item| item.contains("synced model")));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let models = db.provider_models().await.unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].provider, "cutover-gateway");
    assert_eq!(
        models[0].metadata.limit.as_ref().unwrap().input,
        Some(16000)
    );
    let aliases = db.model_aliases().await.unwrap();
    assert_eq!(aliases.len(), 1);
    assert_eq!(aliases[0].provider, "openrouter");
    assert_eq!(aliases[0].model, "vendor/model");
    db.close().await.unwrap();
    let mut saved =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&destination))
            .await
            .unwrap();
    let staged: String = sqlx::query_scalar(
        "SELECT value FROM redrouter_legacy_synced_model_records WHERE legacy_key=?",
    )
    .bind("openrouter:account-123")
    .fetch_one(&mut saved)
    .await
    .unwrap();
    assert_eq!(staged, original_inventory);
    saved.close().await.unwrap();
    assert_eq!(before, tokio::fs::read(&source).await.unwrap());
    assert!(backup.exists());
}

#[tokio::test]
async fn cutover_restores_prior_stages_when_alias_behavior_is_unsupported() {
    let (dir, source, destination, _) =
        model_fixture(r#"[{"id":"custom-model","source":"manual"}]"#).await;
    let mut source_db =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
            .await
            .unwrap();
    // Prefix stripping has no Rust equivalent yet; glob aliases now migrate.
    sqlx::query("INSERT INTO key_value VALUES ('settings','stripModelPrefix','true')")
        .execute(&mut source_db)
        .await
        .unwrap();
    source_db.close().await.unwrap();
    let before = tokio::fs::read(&destination).await.unwrap();
    let backup = dir.path().join("rollback.sqlite");
    let error = match legacy_cutover::migrate(&source, &destination, &backup, STORAGE_KEY).await {
        Ok(_) => panic!("unsupported aliases must abort cutover"),
        Err(error) => error,
    };
    assert!(
        error.contains("migration failed during model aliases"),
        "{error}"
    );
    assert!(error.contains("destination restored"), "{error}");
    assert_eq!(before, tokio::fs::read(&destination).await.unwrap());
    assert_eq!(before, tokio::fs::read(&backup).await.unwrap());
}

#[tokio::test]
async fn cutover_restores_every_prior_stage_if_model_cannot_be_migrated() {
    let (dir, source, destination, _) =
        model_fixture(r#"[{"id":"custom-model","targetFormat":"claude"}]"#).await;
    let before = tokio::fs::read(&destination).await.unwrap();
    let backup = dir.path().join("rollback.sqlite");
    let error = match legacy_cutover::migrate(&source, &destination, &backup, STORAGE_KEY).await {
        Ok(_) => panic!("unsupported model setting must abort cutover"),
        Err(error) => error,
    };
    assert!(
        error.contains("migration failed during custom models"),
        "{error}"
    );
    assert!(error.contains("destination restored"), "{error}");
    assert_eq!(before, tokio::fs::read(&destination).await.unwrap());
    assert_eq!(before, tokio::fs::read(&backup).await.unwrap());
}

#[tokio::test]
async fn orchestrated_migration_restores_destination_when_a_later_slice_fails() {
    let directory = tempdir().unwrap();
    let source = directory.path().join("legacy.sqlite");
    let destination = directory.path().join("rust.sqlite");
    let rollback = directory.path().join("rust.before-cutover.sqlite");

    let mut legacy = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TABLE key_value(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace,key)); INSERT INTO key_value VALUES('pricing','snapshot','new-price');")
        .execute(&mut legacy)
        .await
        .unwrap();
    legacy.close().await.unwrap();

    let mut rust = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&destination)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TABLE key_value(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace,key)); INSERT INTO key_value VALUES('existing','sentinel','unchanged');")
        .execute(&mut rust)
        .await
        .unwrap();
    rust.close().await.unwrap();

    let error = match legacy_cutover::migrate(&source, &destination, &rollback, STORAGE_KEY).await {
        Ok(_) => panic!("incomplete legacy schema must fail"),
        Err(error) => error,
    };
    assert!(error.contains("migration failed during client keys"));
    assert!(error.contains("destination restored"));
    assert!(rollback.exists());

    let mut restored = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&destination)
            .read_only(true),
    )
    .await
    .unwrap();
    let sentinel: String = sqlx::query_scalar(
        "SELECT value FROM key_value WHERE namespace='existing' AND key='sentinel'",
    )
    .fetch_one(&mut restored)
    .await
    .unwrap();
    let imported: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM key_value WHERE namespace='pricing'")
            .fetch_one(&mut restored)
            .await
            .unwrap();
    assert_eq!(sentinel, "unchanged");
    assert_eq!(imported, 0);
}

/// The database a fresh legacy install creates (`fixtures/legacy_reference`,
/// generated from the legacy bootstrap and migrations) goes through the whole
/// offline cutover with no refusal, and the legacy file is left untouched.
#[tokio::test]
async fn a_fresh_legacy_install_cuts_over_without_refusals() {
    let directory = tempdir().unwrap();
    let source = directory.path().join("legacy.sqlite");
    let destination = directory.path().join("rust.sqlite");
    let mut legacy = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "fixtures/legacy_reference/legacy_reference.sql"
    ))
    .execute(&mut legacy)
    .await
    .unwrap();
    // Every store carries the seeded detailed-logging flag (legacy migration 014).
    let seeded: String = sqlx::query_scalar(
        "SELECT value FROM key_value WHERE namespace='settings' AND key='call_log_pipeline_enabled'",
    )
    .fetch_one(&mut legacy)
    .await
    .unwrap();
    assert_eq!(seeded, "0");
    let api_key_columns: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('api_keys')")
            .fetch_one(&mut legacy)
            .await
            .unwrap();
    assert_eq!(api_key_columns, 42);
    legacy.close().await.unwrap();
    let file = Url::from_file_path(&destination).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
    let before = tokio::fs::read(&source).await.unwrap();
    let rollback = directory.path().join("rollback.sqlite");

    let report = legacy_cutover::migrate(&source, &destination, &rollback, STORAGE_KEY)
        .await
        .unwrap();

    assert!(report.activation_required);
    assert!(!report.settings.runtime_settings_imported);
    assert_eq!(report.keys.imported, 0);
    assert_eq!(report.providers.staged, 0);
    assert_eq!(before, tokio::fs::read(&source).await.unwrap());
    assert!(rollback.exists());
}

/// Legacy combos are staged losslessly in the archive for adoption once
/// their providers are adopted: a fresh legacy install plus one combo cuts
/// over, and the combo row is kept exactly.
#[tokio::test]
async fn legacy_combos_are_archived_for_adoption() {
    let directory = tempdir().unwrap();
    let source = directory.path().join("legacy.sqlite");
    let destination = directory.path().join("rust.sqlite");
    let mut legacy = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "fixtures/legacy_reference/legacy_reference.sql"
    ))
    .execute(&mut legacy)
    .await
    .unwrap();
    let data = r#"{"id":"combo-1","name":"my-combo","models":[{"provider":"openai","model":"gpt-5.6"}],"strategy":"priority","config":{}}"#;
    sqlx::query("INSERT INTO combos (id, name, data, sort_order, created_at, updated_at, context_cache_protection) VALUES ('combo-1', 'my-combo', ?, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0)")
        .bind(data)
        .execute(&mut legacy)
        .await
        .unwrap();
    legacy.close().await.unwrap();
    let file = Url::from_file_path(&destination).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();

    let report = legacy_cutover::migrate(
        &source,
        &destination,
        &directory.path().join("rollback.sqlite"),
        STORAGE_KEY,
    )
    .await
    .unwrap();

    assert!(report
        .usage_archive
        .tables
        .iter()
        .any(|table| table.source == "combos" && table.rows == Some(1)));
    assert!(report.follow_up.iter().any(|item| item.contains("combos")));
    let mut saved =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&destination))
            .await
            .unwrap();
    let archived: String =
        sqlx::query_scalar("SELECT data FROM redrouter_legacy_combos WHERE id = 'combo-1'")
            .fetch_one(&mut saved)
            .await
            .unwrap();
    assert_eq!(archived, data);
    saved.close().await.unwrap();
}

/// The table inventory over a fresh legacy install: its seeded rows pass; a
/// configured seed or an unknown table with rows does not.
#[tokio::test]
async fn the_table_inventory_accepts_seeds_and_refuses_configuration() {
    let directory = tempdir().unwrap();
    let source = directory.path().join("legacy.sqlite");
    let mut legacy = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "fixtures/legacy_reference/legacy_reference.sql"
    ))
    .execute(&mut legacy)
    .await
    .unwrap();
    // The seeded rows of a fresh install are accepted.
    legacy.close().await.unwrap();
    assert_eq!(
        red_routerd::legacy_tables::refusal(&source).await.unwrap(),
        None
    );

    let mut legacy = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::query("UPDATE jobs SET enabled = 1 WHERE id = 'warmup'")
        .execute(&mut legacy)
        .await
        .unwrap();
    legacy.close().await.unwrap();
    let refusal = red_routerd::legacy_tables::refusal(&source)
        .await
        .unwrap()
        .unwrap();
    assert!(refusal.contains("background jobs (jobs)"), "{refusal}");

    let mut legacy = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::raw_sql("UPDATE jobs SET enabled = 0 WHERE id = 'warmup'; CREATE TABLE future_feature (id TEXT); INSERT INTO future_feature VALUES ('x');")
        .execute(&mut legacy)
        .await
        .unwrap();
    legacy.close().await.unwrap();
    let refusal = red_routerd::legacy_tables::refusal(&source)
        .await
        .unwrap()
        .unwrap();
    assert!(
        refusal.contains("future_feature is not in the migration inventory"),
        "{refusal}"
    );
}

/// key_value namespaces follow the same inventory: process secrets pass, a
/// configured seed, a feature without an importer and an unknown namespace
/// refuse.
#[tokio::test]
async fn key_value_namespaces_have_explicit_cutover_decisions() {
    let directory = tempdir().unwrap();
    let source = directory.path().join("legacy.sqlite");
    let mut legacy = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "fixtures/legacy_reference/legacy_reference.sql"
    ))
    .execute(&mut legacy)
    .await
    .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('secrets', 'jwtSecret', '\"generated\"')")
        .execute(&mut legacy)
        .await
        .unwrap();
    legacy.close().await.unwrap();
    assert_eq!(
        red_routerd::legacy_tables::refusal(&source).await.unwrap(),
        None
    );

    for (setup, expected) in [
        (
            "UPDATE key_value SET value = '30' WHERE namespace = 'databaseSettings' AND key = 'usageHistory'",
            "database settings (key_value namespace databaseSettings)",
        ),
        (
            "INSERT INTO key_value VALUES ('feature_flags', 'SOME_FLAG', 'true')",
            "feature flag overrides (key_value namespace feature_flags)",
        ),
        (
            "INSERT INTO key_value VALUES ('futureNamespace', 'k', 'v')",
            "key_value namespace futureNamespace is not in the migration inventory",
        ),
    ] {
        let copy = directory.path().join("copy.sqlite");
        std::fs::copy(&source, &copy).unwrap();
        let mut legacy =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&copy))
                .await
                .unwrap();
        sqlx::query(setup).execute(&mut legacy).await.unwrap();
        legacy.close().await.unwrap();
        let refusal = red_routerd::legacy_tables::refusal(&copy)
            .await
            .unwrap()
            .unwrap();
        assert!(refusal.contains(expected), "{setup}: {refusal}");
        std::fs::remove_file(&copy).unwrap();
    }
}
