use red_routerd::legacy_settings::{self, SettingClass};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::TempDir;

#[tokio::test]
async fn settings_inventory_classifies_rows_without_exposing_or_modifying_them() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("legacy.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql(
        "CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT);
         INSERT INTO key_value VALUES
           ('settings','requestRetry','3'),
           ('settings','comboStrategy','\"round-robin\"'),
           ('settings','theme','\"secret-theme\"'),
           ('settings','payloadRules','{\"secret\":true}'),
           ('settings','unknownFutureSetting','\"secret-value\"'),
           ('settings','_internalCursor','\"skipped\"'),
           ('settings','nullValue',NULL),
           ('pricing','openai','{}');",
    )
    .execute(&mut db)
    .await
    .unwrap();
    db.close().await.unwrap();
    let before = tokio::fs::read(&path).await.unwrap();

    let report = legacy_settings::inspect(&path).await.unwrap();
    assert_eq!(report.settings["requestRetry"], SettingClass::AtDefault);
    assert_eq!(report.settings["theme"], SettingClass::Dashboard);
    assert_eq!(
        report.settings["payloadRules"],
        SettingClass::Consumed {
            importer: "legacy_payload_rules"
        }
    );
    assert!(matches!(
        report.settings["comboStrategy"],
        SettingClass::Refused { .. }
    ));
    // Internal and empty rows are skipped like the legacy loader does.
    assert!(!report.settings.contains_key("_internalCursor"));
    assert!(!report.settings.contains_key("nullValue"));
    let mut refused = report.refused().map(|(key, _)| key).collect::<Vec<_>>();
    refused.sort_unstable();
    assert_eq!(refused, ["comboStrategy", "unknownFutureSetting"]);
    // The report names keys only, never stored values.
    let encoded = serde_json::to_string(&report).unwrap();
    assert!(!encoded.contains("secret"));
    assert_eq!(before, tokio::fs::read(&path).await.unwrap());
}

#[tokio::test]
async fn resilience_settings_import_onto_native_runtime_settings_once() {
    use red_routerd::storage::{Backend, Database};
    let directory = TempDir::new().unwrap();
    let source = directory.path().join("legacy.sqlite");
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql(
        "CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT);
         INSERT INTO key_value VALUES
           ('settings','theme','\"dark\"'),
           ('settings','customSystemPromptEnabled','true'),
           ('settings','customSystemPrompt','\"Be terse.\"'),
           ('settings','customBannedSignals','[\" Account Frozen \",\"\",\"tos strike\"]'),
           ('settings','resilienceSettings','{\"connectionCooldown\":{\"apikey\":{\"baseCooldownMs\":1500}},\"quotaPreflight\":{\"enabled\":true,\"defaultThresholdPercent\":5}}');",
    )
    .execute(&mut db)
    .await
    .unwrap();
    db.close().await.unwrap();
    let file = url::Url::from_file_path(directory.path().join("rust.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let destination = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert!(destination.runtime_settings().await.unwrap().is_none());

    let report = legacy_settings::import(&source, &destination)
        .await
        .unwrap();
    assert!(report.runtime_settings_imported);
    assert_eq!(report.custom_banned_signals, 2);
    assert!(report.custom_system_prompt_imported);
    assert_eq!(
        destination.global_settings().await.unwrap()["custom_system_prompt"],
        serde_json::json!({"enabled":true,"prompt":"Be terse."})
    );
    assert_eq!(
        destination.custom_banned_signals().await.unwrap(),
        ["Account Frozen", "tos strike"]
    );
    let stored = destination.runtime_settings().await.unwrap().unwrap();
    assert!(stored.quota_preflight_enabled);
    assert_eq!(stored.quota_preflight_threshold_ppm, 50_000);
    assert_eq!(
        (
            stored.apikey_cooldown_base_ms,
            stored.apikey_cooldown_retry_hints,
            stored.apikey_cooldown_max_backoff_steps
        ),
        (1_500, true, 5)
    );
    assert_eq!(stored.oauth_cooldown_base_ms, 5_000);
    assert_eq!(
        (
            stored.apikey_breaker_failure_threshold,
            stored.apikey_breaker_degradation_threshold,
            stored.apikey_breaker_reset_timeout_ms
        ),
        (12, 7, 30_000)
    );
    // The cutover never overwrites configured native settings.
    assert_eq!(
        legacy_settings::import(&source, &destination).await.err(),
        Some("destination runtime settings are already configured")
    );
    destination.close().await.unwrap();

    // Any refused row stops the import before anything is written.
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::query("INSERT INTO key_value VALUES ('settings','requestRetry','7')")
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
    let file = url::Url::from_file_path(directory.path().join("fresh.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let fresh = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert_eq!(
        legacy_settings::import(&source, &fresh).await.err(),
        Some("legacy settings require migration; nothing imported")
    );
    assert!(fresh.runtime_settings().await.unwrap().is_none());
    fresh.close().await.unwrap();
}
